const Buffer = require('safe-buffer').Buffer
const Trie = require('merkle-patricia-tree/secure.js')
const common = require('ethereum-common')
const async = require('async')
const Account = require('ethereumjs-account')
const fakeBlockchain = require('./fakeBlockChain.js')
const Cache = require('./cache.js')
const utils = require('ethereumjs-util')
const BN = utils.BN
const rlp = utils.rlp

module.exports = StateManager

function StateManager (opts) {
  var self = this

  var trie = opts.trie
  if (!trie) {
    trie = new Trie(trie)
  }

  var blockchain = opts.blockchain
  if (!blockchain) {
    blockchain = fakeBlockchain
  }

  self.blockchain = blockchain
  self.trie = trie
  self._storageTries = {} // the storage trie cache
  self.cache = new Cache(trie)
  self._touched = new Set()
}

var proto = StateManager.prototype

proto.copy = function () {
  return new StateManager({ trie: this.trie.copy(), blockchain: this.blockchain })
}

// gets the account from the cache, or triggers a lookup and stores
// the result in the cache
proto.getAccount = function (address, cb) {
  this.cache.getOrLoad(address, cb)
}

// checks if an account exists
proto.exists = function (address, cb) {
  this.cache.getOrLoad(address, function (err, account) {
    cb(err, account.exists)
  })
}

// saves the account
proto.putAccount = function (address, account, cb) {
  var self = this
  // TODO: dont save newly created accounts that have no balance
  // if (toAccount.balance.toString('hex') === '00') {
  // if they have money or a non-zero nonce or code, then write to tree
  self.cache.put(address, account)
  self._touched.add(address.toString('hex'))
  // self.trie.put(addressHex, account.serialize(), cb)
  cb()
}

proto.getAccountBalance = function (address, cb) {
  var self = this
  self.getAccount(address, function (err, account) {
    if (err) {
      return cb(err)
    }
    cb(null, account.balance)
  })
}

proto.putAccountBalance = function (address, balance, cb) {
  var self = this

  self.getAccount(address, function (err, account) {
    if (err) {
      return cb(err)
    }

    if ((new BN(balance)).isZero() && !account.exists) {
      return cb(null)
    }

    account.balance = balance
    self.putAccount(address, account, cb)
  })
}

// sets the contract code on the account
proto.putContractCode = function (address, value, cb) {
  var self = this
  self.getAccount(address, function (err, account) {
    if (err) {
      return cb(err)
    }
    // TODO: setCode use trie.setRaw which creates a storage leak
    account.setCode(self.trie, value, function (err) {
      if (err) {
        return cb(err)
      }
      self.putAccount(address, account, cb)
    })
  })
}

// given an account object, returns the code
proto.getContractCode = function (address, cb) {
  var self = this
  self.getAccount(address, function (err, account) {
    if (err) {
      return cb(err)
    }
    account.getCode(self.trie, cb)
  })
}

// creates a storage trie from the primary storage trie
proto._lookupStorageTrie = function (address, cb) {
  var self = this
  // from state trie
  self.getAccount(address, function (err, account) {
    if (err) {
      return cb(err)
    }
    var storageTrie = self.trie.copy()
    storageTrie.root = account.stateRoot
    storageTrie._checkpoints = []
    cb(null, storageTrie)
  })
}

// gets the storage trie from the storage cache or does lookup
proto._getStorageTrie = function (address, cb) {
  var self = this
  var storageTrie = self._storageTries[address.toString('hex')]
  // from storage cache
  if (storageTrie) {
    return cb(null, storageTrie)
  }
  // lookup from state
  self._lookupStorageTrie(address, cb)
}

proto.getContractStorage = function (address, key, cb) {
  var self = this
  self._getStorageTrie(address, function (err, trie) {
    if (err) {
      return cb(err)
    }
    trie.get(key, function (err, value) {
      if (err) {
        return cb(err)
      }
      var decoded = rlp.decode(value)
      cb(null, decoded)
    })
  })
}

proto._modifyContractStorage = function (address, modifyTrie, cb) {
  var self = this
  self._getStorageTrie(address, function (err, storageTrie) {
    if (err) {
      return cb(err)
    }

    modifyTrie(storageTrie, finalize)

    function finalize (err) {
      if (err) return cb(err)
      // update storage cache
      self._storageTries[address.toString('hex')] = storageTrie
      // update contract stateRoot
      var contract = self.cache.get(address)
      contract.stateRoot = storageTrie.root
      self.putAccount(address, contract, cb)
      self._touched.add(address.toString('hex'))
    }
  })
}

proto.putContractStorage = function (address, key, value, cb) {
  var self = this
  self._modifyContractStorage(address, function (storageTrie, done) {
    if (value && value.length) {
      // format input
      var encodedValue = rlp.encode(value)
      storageTrie.put(key, encodedValue, done)
    } else {
      // deleting a value
      storageTrie.del(key, done)
    }
  }, cb)
}

proto.clearContractStorage = function (address, cb) {
  var self = this
  self._modifyContractStorage(address, function (storageTrie, done) {
    storageTrie.root = storageTrie.EMPTY_TRIE_ROOT
    done()
  }, cb)
}

proto.commitContracts = function (cb) {
  var self = this
  async.each(Object.keys(self._storageTries), function (address, cb) {
    var trie = self._storageTries[address]
    delete self._storageTries[address]
    // TODO: this is broken on the block level; all the contracts get written to
    // disk redardless of whether or not the block is valid
    if (trie.isCheckpoint) {
      trie.commit(cb)
    } else {
      cb()
    }
  }, cb)
}

proto.revertContracts = function () {
  var self = this
  self._storageTries = {}
  self._touched.clear()
}

//
// blockchain
//
proto.getBlockHash = function (number, cb) {
  var self = this
  self.blockchain.getBlock(number, function (err, block) {
    if (err) {
      return cb(err)
    }
    var blockHash = block.hash()
    cb(null, blockHash)
  })
}

//
// revision history
//
proto.checkpoint = function () {
  var self = this
  self.trie.checkpoint()
  self.cache.checkpoint()
}

proto.commit = function (cb) {
  var self = this
  // setup trie checkpointing
  self.trie.commit(function () {
    // setup cache checkpointing
    self.cache.commit()
    cb()
  })
}

proto.revert = function (cb) {
  var self = this
  // setup trie checkpointing
  self.trie.revert()
  // setup cache checkpointing
  self.cache.revert()
  cb()
}

//
// cache stuff
//
proto.getStateRoot = function (cb) {
  var self = this
  self.cacheFlush(function (err) {
    if (err) {
      return cb(err)
    }
    var stateRoot = self.trie.root
    cb(null, stateRoot)
  })
}

/**
 * @param {Set} address
 * @param {cb} function
 */
proto.warmCache = function (addresses, cb) {
  this.cache.warm(addresses, cb)
}

proto.dumpStorage = function (address, cb) {
  var self = this
  self._getStorageTrie(address, function (err, trie) {
    if (err) {
      return cb(err)
    }
    var storage = {}
    var stream = trie.createReadStream()
    stream.on('data', function (val) {
      storage[val.key.toString('hex')] = val.value.toString('hex')
    })
    stream.on('end', function () {
      cb(storage)
    })
  })
}

proto.hasGenesisState = function (cb) {
  const root = common.genesisStateRoot.v
  this.trie.checkRoot(root, cb)
}

proto.generateCanonicalGenesis = function (cb) {
  var self = this

  this.hasGenesisState(function (err, genesis) {
    if (!genesis && !err) {
      self.generateGenesis(common.genesisState, cb)
    } else {
      cb(err)
    }
  })
}

proto.generateGenesis = function (initState, cb) {
  var self = this
  var addresses = Object.keys(initState)
  async.eachSeries(addresses, function (address, done) {
    var account = new Account()
    account.balance = new BN(initState[address]).toArrayLike(Buffer)
    address = Buffer.from(address, 'hex')
    self.trie.put(address, account.serialize(), done)
  }, cb)
}

proto.accountIsEmpty = function (address, cb) {
  var self = this
  self.getAccount(address, function (err, account) {
    if (err) {
      return cb(err)
    }

    cb(null, account.nonce.toString('hex') === '' && account.balance.toString('hex') === '' && account.codeHash.toString('hex') === utils.SHA3_NULL_S)
  })
}

proto.cleanupTouchedAccounts = function (cb) {
  var self = this
  var touchedArray = Array.from(self._touched)
  async.forEach(touchedArray, function (addressHex, next) {
    var address = Buffer.from(addressHex, 'hex')
    self.accountIsEmpty(address, function (err, empty) {
      if (err) {
        next(err)
        return
      }

      if (empty) {
        self.cache.del(address)
      }
      next(null)
    })
  },
  function () {
    self._touched.clear()
    cb()
  })
}
