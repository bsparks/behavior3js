"format global";
(function(global) {

  var defined = {};

  // indexOf polyfill for IE8
  var indexOf = Array.prototype.indexOf || function(item) {
    for (var i = 0, l = this.length; i < l; i++)
      if (this[i] === item)
        return i;
    return -1;
  }

  var getOwnPropertyDescriptor = true;
  try {
    Object.getOwnPropertyDescriptor({ a: 0 }, 'a');
  }
  catch(e) {
    getOwnPropertyDescriptor = false;
  }

  var defineProperty;
  (function () {
    try {
      if (!!Object.defineProperty({}, 'a', {}))
        defineProperty = Object.defineProperty;
    }
    catch (e) {
      defineProperty = function(obj, prop, opt) {
        try {
          obj[prop] = opt.value || opt.get.call(obj);
        }
        catch(e) {}
      }
    }
  })();

  function register(name, deps, declare) {
    if (arguments.length === 4)
      return registerDynamic.apply(this, arguments);
    doRegister(name, {
      declarative: true,
      deps: deps,
      declare: declare
    });
  }

  function registerDynamic(name, deps, executingRequire, execute) {
    doRegister(name, {
      declarative: false,
      deps: deps,
      executingRequire: executingRequire,
      execute: execute
    });
  }

  function doRegister(name, entry) {
    entry.name = name;

    // we never overwrite an existing define
    if (!(name in defined))
      defined[name] = entry;

    // we have to normalize dependencies
    // (assume dependencies are normalized for now)
    // entry.normalizedDeps = entry.deps.map(normalize);
    entry.normalizedDeps = entry.deps;
  }


  function buildGroups(entry, groups) {
    groups[entry.groupIndex] = groups[entry.groupIndex] || [];

    if (indexOf.call(groups[entry.groupIndex], entry) != -1)
      return;

    groups[entry.groupIndex].push(entry);

    for (var i = 0, l = entry.normalizedDeps.length; i < l; i++) {
      var depName = entry.normalizedDeps[i];
      var depEntry = defined[depName];

      // not in the registry means already linked / ES6
      if (!depEntry || depEntry.evaluated)
        continue;

      // now we know the entry is in our unlinked linkage group
      var depGroupIndex = entry.groupIndex + (depEntry.declarative != entry.declarative);

      // the group index of an entry is always the maximum
      if (depEntry.groupIndex === undefined || depEntry.groupIndex < depGroupIndex) {

        // if already in a group, remove from the old group
        if (depEntry.groupIndex !== undefined) {
          groups[depEntry.groupIndex].splice(indexOf.call(groups[depEntry.groupIndex], depEntry), 1);

          // if the old group is empty, then we have a mixed depndency cycle
          if (groups[depEntry.groupIndex].length == 0)
            throw new TypeError("Mixed dependency cycle detected");
        }

        depEntry.groupIndex = depGroupIndex;
      }

      buildGroups(depEntry, groups);
    }
  }

  function link(name) {
    var startEntry = defined[name];

    startEntry.groupIndex = 0;

    var groups = [];

    buildGroups(startEntry, groups);

    var curGroupDeclarative = !!startEntry.declarative == groups.length % 2;
    for (var i = groups.length - 1; i >= 0; i--) {
      var group = groups[i];
      for (var j = 0; j < group.length; j++) {
        var entry = group[j];

        // link each group
        if (curGroupDeclarative)
          linkDeclarativeModule(entry);
        else
          linkDynamicModule(entry);
      }
      curGroupDeclarative = !curGroupDeclarative; 
    }
  }

  // module binding records
  var moduleRecords = {};
  function getOrCreateModuleRecord(name) {
    return moduleRecords[name] || (moduleRecords[name] = {
      name: name,
      dependencies: [],
      exports: {}, // start from an empty module and extend
      importers: []
    })
  }

  function linkDeclarativeModule(entry) {
    // only link if already not already started linking (stops at circular)
    if (entry.module)
      return;

    var module = entry.module = getOrCreateModuleRecord(entry.name);
    var exports = entry.module.exports;

    var declaration = entry.declare.call(global, function(name, value) {
      module.locked = true;

      if (typeof name == 'object') {
        for (var p in name)
          exports[p] = name[p];
      }
      else {
        exports[name] = value;
      }

      for (var i = 0, l = module.importers.length; i < l; i++) {
        var importerModule = module.importers[i];
        if (!importerModule.locked) {
          for (var j = 0; j < importerModule.dependencies.length; ++j) {
            if (importerModule.dependencies[j] === module) {
              importerModule.setters[j](exports);
            }
          }
        }
      }

      module.locked = false;
      return value;
    });

    module.setters = declaration.setters;
    module.execute = declaration.execute;

    // now link all the module dependencies
    for (var i = 0, l = entry.normalizedDeps.length; i < l; i++) {
      var depName = entry.normalizedDeps[i];
      var depEntry = defined[depName];
      var depModule = moduleRecords[depName];

      // work out how to set depExports based on scenarios...
      var depExports;

      if (depModule) {
        depExports = depModule.exports;
      }
      else if (depEntry && !depEntry.declarative) {
        depExports = depEntry.esModule;
      }
      // in the module registry
      else if (!depEntry) {
        depExports = load(depName);
      }
      // we have an entry -> link
      else {
        linkDeclarativeModule(depEntry);
        depModule = depEntry.module;
        depExports = depModule.exports;
      }

      // only declarative modules have dynamic bindings
      if (depModule && depModule.importers) {
        depModule.importers.push(module);
        module.dependencies.push(depModule);
      }
      else
        module.dependencies.push(null);

      // run the setter for this dependency
      if (module.setters[i])
        module.setters[i](depExports);
    }
  }

  // An analog to loader.get covering execution of all three layers (real declarative, simulated declarative, simulated dynamic)
  function getModule(name) {
    var exports;
    var entry = defined[name];

    if (!entry) {
      exports = load(name);
      if (!exports)
        throw new Error("Unable to load dependency " + name + ".");
    }

    else {
      if (entry.declarative)
        ensureEvaluated(name, []);

      else if (!entry.evaluated)
        linkDynamicModule(entry);

      exports = entry.module.exports;
    }

    if ((!entry || entry.declarative) && exports && exports.__useDefault)
      return exports['default'];

    return exports;
  }

  function linkDynamicModule(entry) {
    if (entry.module)
      return;

    var exports = {};

    var module = entry.module = { exports: exports, id: entry.name };

    // AMD requires execute the tree first
    if (!entry.executingRequire) {
      for (var i = 0, l = entry.normalizedDeps.length; i < l; i++) {
        var depName = entry.normalizedDeps[i];
        var depEntry = defined[depName];
        if (depEntry)
          linkDynamicModule(depEntry);
      }
    }

    // now execute
    entry.evaluated = true;
    var output = entry.execute.call(global, function(name) {
      for (var i = 0, l = entry.deps.length; i < l; i++) {
        if (entry.deps[i] != name)
          continue;
        return getModule(entry.normalizedDeps[i]);
      }
      throw new TypeError('Module ' + name + ' not declared as a dependency.');
    }, exports, module);

    if (output)
      module.exports = output;

    // create the esModule object, which allows ES6 named imports of dynamics
    exports = module.exports;
 
    if (exports && exports.__esModule) {
      entry.esModule = exports;
    }
    else {
      entry.esModule = {};
      
      // don't trigger getters/setters in environments that support them
      if (typeof exports == 'object' || typeof exports == 'function') {
        if (getOwnPropertyDescriptor) {
          var d;
          for (var p in exports)
            if (d = Object.getOwnPropertyDescriptor(exports, p))
              defineProperty(entry.esModule, p, d);
        }
        else {
          var hasOwnProperty = exports && exports.hasOwnProperty;
          for (var p in exports) {
            if (!hasOwnProperty || exports.hasOwnProperty(p))
              entry.esModule[p] = exports[p];
          }
         }
       }
      entry.esModule['default'] = exports;
      defineProperty(entry.esModule, '__useDefault', {
        value: true
      });
    }
  }

  /*
   * Given a module, and the list of modules for this current branch,
   *  ensure that each of the dependencies of this module is evaluated
   *  (unless one is a circular dependency already in the list of seen
   *  modules, in which case we execute it)
   *
   * Then we evaluate the module itself depth-first left to right 
   * execution to match ES6 modules
   */
  function ensureEvaluated(moduleName, seen) {
    var entry = defined[moduleName];

    // if already seen, that means it's an already-evaluated non circular dependency
    if (!entry || entry.evaluated || !entry.declarative)
      return;

    // this only applies to declarative modules which late-execute

    seen.push(moduleName);

    for (var i = 0, l = entry.normalizedDeps.length; i < l; i++) {
      var depName = entry.normalizedDeps[i];
      if (indexOf.call(seen, depName) == -1) {
        if (!defined[depName])
          load(depName);
        else
          ensureEvaluated(depName, seen);
      }
    }

    if (entry.evaluated)
      return;

    entry.evaluated = true;
    entry.module.execute.call(global);
  }

  // magical execution function
  var modules = {};
  function load(name) {
    if (modules[name])
      return modules[name];

    // node core modules
    if (name.substr(0, 6) == '@node/')
      return require(name.substr(6));

    var entry = defined[name];

    // first we check if this module has already been defined in the registry
    if (!entry)
      throw "Module " + name + " not present.";

    // recursively ensure that the module and all its 
    // dependencies are linked (with dependency group handling)
    link(name);

    // now handle dependency execution in correct order
    ensureEvaluated(name, []);

    // remove from the registry
    defined[name] = undefined;

    // exported modules get __esModule defined for interop
    if (entry.declarative)
      defineProperty(entry.module.exports, '__esModule', { value: true });

    // return the defined module object
    return modules[name] = entry.declarative ? entry.module.exports : entry.esModule;
  };

  return function(mains, depNames, declare) {
    return function(formatDetect) {
      formatDetect(function(deps) {
        var System = {
          _nodeRequire: typeof require != 'undefined' && require.resolve && typeof process != 'undefined' && require,
          register: register,
          registerDynamic: registerDynamic,
          get: load, 
          set: function(name, module) {
            modules[name] = module; 
          },
          newModule: function(module) {
            return module;
          }
        };
        System.set('@empty', {});

        // register external dependencies
        for (var i = 0; i < depNames.length; i++) (function(depName, dep) {
          if (dep && dep.__esModule)
            System.register(depName, [], function(_export) {
              return {
                setters: [],
                execute: function() {
                  for (var p in dep)
                    if (p != '__esModule' && !(typeof p == 'object' && p + '' == 'Module'))
                      _export(p, dep[p]);
                }
              };
            });
          else
            System.registerDynamic(depName, [], false, function() {
              return dep;
            });
        })(depNames[i], arguments[i]);

        // register modules in this bundle
        declare(System);

        // load mains
        var firstLoad = load(mains[0]);
        if (mains.length > 1)
          for (var i = 1; i < mains.length; i++)
            load(mains[i]);

        if (firstLoad.__useDefault)
          return firstLoad['default'];
        else
          return firstLoad;
      });
    };
  };

})(typeof self != 'undefined' ? self : global)
/* (['mainModule'], ['external-dep'], function($__System) {
  System.register(...);
})
(function(factory) {
  if (typeof define && define.amd)
    define(['external-dep'], factory);
  // etc UMD / module pattern
})*/

(['1'], [], function($__System) {

$__System.registerDynamic("2", [], true, function(require, exports, module) {
  ;
  var global = this,
      __define = global.define;
  global.define = undefined;
  var $Object = Object;
  module.exports = {
    create: $Object.create,
    getProto: $Object.getPrototypeOf,
    isEnum: {}.propertyIsEnumerable,
    getDesc: $Object.getOwnPropertyDescriptor,
    setDesc: $Object.defineProperty,
    setDescs: $Object.defineProperties,
    getKeys: $Object.keys,
    getNames: $Object.getOwnPropertyNames,
    getSymbols: $Object.getOwnPropertySymbols,
    each: [].forEach
  };
  global.define = __define;
  return module.exports;
});

$__System.registerDynamic("3", [], true, function(require, exports, module) {
  ;
  var global = this,
      __define = global.define;
  global.define = undefined;
  var global = module.exports = typeof window != 'undefined' && window.Math == Math ? window : typeof self != 'undefined' && self.Math == Math ? self : Function('return this')();
  if (typeof __g == 'number')
    __g = global;
  global.define = __define;
  return module.exports;
});

$__System.registerDynamic("4", [], true, function(require, exports, module) {
  ;
  var global = this,
      __define = global.define;
  global.define = undefined;
  var hasOwnProperty = {}.hasOwnProperty;
  module.exports = function(it, key) {
    return hasOwnProperty.call(it, key);
  };
  global.define = __define;
  return module.exports;
});

$__System.registerDynamic("5", [], true, function(require, exports, module) {
  ;
  var global = this,
      __define = global.define;
  global.define = undefined;
  module.exports = function(exec) {
    try {
      return !!exec();
    } catch (e) {
      return true;
    }
  };
  global.define = __define;
  return module.exports;
});

$__System.registerDynamic("6", ["5"], true, function(require, exports, module) {
  ;
  var global = this,
      __define = global.define;
  global.define = undefined;
  module.exports = !require("5")(function() {
    return Object.defineProperty({}, 'a', {get: function() {
        return 7;
      }}).a != 7;
  });
  global.define = __define;
  return module.exports;
});

$__System.registerDynamic("7", [], true, function(require, exports, module) {
  ;
  var global = this,
      __define = global.define;
  global.define = undefined;
  var core = module.exports = {version: '1.2.5'};
  if (typeof __e == 'number')
    __e = core;
  global.define = __define;
  return module.exports;
});

$__System.registerDynamic("8", ["3", "7"], true, function(require, exports, module) {
  ;
  var global = this,
      __define = global.define;
  global.define = undefined;
  var global = require("3"),
      core = require("7"),
      PROTOTYPE = 'prototype';
  var ctx = function(fn, that) {
    return function() {
      return fn.apply(that, arguments);
    };
  };
  var $def = function(type, name, source) {
    var key,
        own,
        out,
        exp,
        isGlobal = type & $def.G,
        isProto = type & $def.P,
        target = isGlobal ? global : type & $def.S ? global[name] : (global[name] || {})[PROTOTYPE],
        exports = isGlobal ? core : core[name] || (core[name] = {});
    if (isGlobal)
      source = name;
    for (key in source) {
      own = !(type & $def.F) && target && key in target;
      if (own && key in exports)
        continue;
      out = own ? target[key] : source[key];
      if (isGlobal && typeof target[key] != 'function')
        exp = source[key];
      else if (type & $def.B && own)
        exp = ctx(out, global);
      else if (type & $def.W && target[key] == out)
        !function(C) {
          exp = function(param) {
            return this instanceof C ? new C(param) : C(param);
          };
          exp[PROTOTYPE] = C[PROTOTYPE];
        }(out);
      else
        exp = isProto && typeof out == 'function' ? ctx(Function.call, out) : out;
      exports[key] = exp;
      if (isProto)
        (exports[PROTOTYPE] || (exports[PROTOTYPE] = {}))[key] = out;
    }
  };
  $def.F = 1;
  $def.G = 2;
  $def.S = 4;
  $def.P = 8;
  $def.B = 16;
  $def.W = 32;
  module.exports = $def;
  global.define = __define;
  return module.exports;
});

$__System.registerDynamic("9", [], true, function(require, exports, module) {
  ;
  var global = this,
      __define = global.define;
  global.define = undefined;
  module.exports = function(bitmap, value) {
    return {
      enumerable: !(bitmap & 1),
      configurable: !(bitmap & 2),
      writable: !(bitmap & 4),
      value: value
    };
  };
  global.define = __define;
  return module.exports;
});

$__System.registerDynamic("a", ["2", "9", "6"], true, function(require, exports, module) {
  ;
  var global = this,
      __define = global.define;
  global.define = undefined;
  var $ = require("2"),
      createDesc = require("9");
  module.exports = require("6") ? function(object, key, value) {
    return $.setDesc(object, key, createDesc(1, value));
  } : function(object, key, value) {
    object[key] = value;
    return object;
  };
  global.define = __define;
  return module.exports;
});

$__System.registerDynamic("b", ["a"], true, function(require, exports, module) {
  ;
  var global = this,
      __define = global.define;
  global.define = undefined;
  module.exports = require("a");
  global.define = __define;
  return module.exports;
});

$__System.registerDynamic("c", ["3"], true, function(require, exports, module) {
  ;
  var global = this,
      __define = global.define;
  global.define = undefined;
  var global = require("3"),
      SHARED = '__core-js_shared__',
      store = global[SHARED] || (global[SHARED] = {});
  module.exports = function(key) {
    return store[key] || (store[key] = {});
  };
  global.define = __define;
  return module.exports;
});

$__System.registerDynamic("d", [], true, function(require, exports, module) {
  ;
  var global = this,
      __define = global.define;
  global.define = undefined;
  var id = 0,
      px = Math.random();
  module.exports = function(key) {
    return 'Symbol('.concat(key === undefined ? '' : key, ')_', (++id + px).toString(36));
  };
  global.define = __define;
  return module.exports;
});

$__System.registerDynamic("e", ["c", "d", "3"], true, function(require, exports, module) {
  ;
  var global = this,
      __define = global.define;
  global.define = undefined;
  var store = require("c")('wks'),
      uid = require("d"),
      Symbol = require("3").Symbol;
  module.exports = function(name) {
    return store[name] || (store[name] = Symbol && Symbol[name] || (Symbol || uid)('Symbol.' + name));
  };
  global.define = __define;
  return module.exports;
});

$__System.registerDynamic("f", ["2", "4", "e"], true, function(require, exports, module) {
  ;
  var global = this,
      __define = global.define;
  global.define = undefined;
  var def = require("2").setDesc,
      has = require("4"),
      TAG = require("e")('toStringTag');
  module.exports = function(it, tag, stat) {
    if (it && !has(it = stat ? it : it.prototype, TAG))
      def(it, TAG, {
        configurable: true,
        value: tag
      });
  };
  global.define = __define;
  return module.exports;
});

$__System.registerDynamic("10", [], true, function(require, exports, module) {
  ;
  var global = this,
      __define = global.define;
  global.define = undefined;
  var toString = {}.toString;
  module.exports = function(it) {
    return toString.call(it).slice(8, -1);
  };
  global.define = __define;
  return module.exports;
});

$__System.registerDynamic("11", ["10"], true, function(require, exports, module) {
  ;
  var global = this,
      __define = global.define;
  global.define = undefined;
  var cof = require("10");
  module.exports = Object('z').propertyIsEnumerable(0) ? Object : function(it) {
    return cof(it) == 'String' ? it.split('') : Object(it);
  };
  global.define = __define;
  return module.exports;
});

$__System.registerDynamic("12", [], true, function(require, exports, module) {
  ;
  var global = this,
      __define = global.define;
  global.define = undefined;
  module.exports = function(it) {
    if (it == undefined)
      throw TypeError("Can't call method on  " + it);
    return it;
  };
  global.define = __define;
  return module.exports;
});

$__System.registerDynamic("13", ["11", "12"], true, function(require, exports, module) {
  ;
  var global = this,
      __define = global.define;
  global.define = undefined;
  var IObject = require("11"),
      defined = require("12");
  module.exports = function(it) {
    return IObject(defined(it));
  };
  global.define = __define;
  return module.exports;
});

$__System.registerDynamic("14", ["2", "13"], true, function(require, exports, module) {
  ;
  var global = this,
      __define = global.define;
  global.define = undefined;
  var $ = require("2"),
      toIObject = require("13");
  module.exports = function(object, el) {
    var O = toIObject(object),
        keys = $.getKeys(O),
        length = keys.length,
        index = 0,
        key;
    while (length > index)
      if (O[key = keys[index++]] === el)
        return key;
  };
  global.define = __define;
  return module.exports;
});

$__System.registerDynamic("15", ["13", "2"], true, function(require, exports, module) {
  ;
  var global = this,
      __define = global.define;
  global.define = undefined;
  var toString = {}.toString,
      toIObject = require("13"),
      getNames = require("2").getNames;
  var windowNames = typeof window == 'object' && Object.getOwnPropertyNames ? Object.getOwnPropertyNames(window) : [];
  var getWindowNames = function(it) {
    try {
      return getNames(it);
    } catch (e) {
      return windowNames.slice();
    }
  };
  module.exports.get = function getOwnPropertyNames(it) {
    if (windowNames && toString.call(it) == '[object Window]')
      return getWindowNames(it);
    return getNames(toIObject(it));
  };
  global.define = __define;
  return module.exports;
});

$__System.registerDynamic("16", ["2"], true, function(require, exports, module) {
  ;
  var global = this,
      __define = global.define;
  global.define = undefined;
  var $ = require("2");
  module.exports = function(it) {
    var keys = $.getKeys(it),
        getSymbols = $.getSymbols;
    if (getSymbols) {
      var symbols = getSymbols(it),
          isEnum = $.isEnum,
          i = 0,
          key;
      while (symbols.length > i)
        if (isEnum.call(it, key = symbols[i++]))
          keys.push(key);
    }
    return keys;
  };
  global.define = __define;
  return module.exports;
});

$__System.registerDynamic("17", ["10"], true, function(require, exports, module) {
  ;
  var global = this,
      __define = global.define;
  global.define = undefined;
  var cof = require("10");
  module.exports = Array.isArray || function(arg) {
    return cof(arg) == 'Array';
  };
  global.define = __define;
  return module.exports;
});

$__System.registerDynamic("18", [], true, function(require, exports, module) {
  ;
  var global = this,
      __define = global.define;
  global.define = undefined;
  module.exports = function(it) {
    return typeof it === 'object' ? it !== null : typeof it === 'function';
  };
  global.define = __define;
  return module.exports;
});

$__System.registerDynamic("19", ["18"], true, function(require, exports, module) {
  ;
  var global = this,
      __define = global.define;
  global.define = undefined;
  var isObject = require("18");
  module.exports = function(it) {
    if (!isObject(it))
      throw TypeError(it + ' is not an object!');
    return it;
  };
  global.define = __define;
  return module.exports;
});

$__System.registerDynamic("1a", [], true, function(require, exports, module) {
  ;
  var global = this,
      __define = global.define;
  global.define = undefined;
  module.exports = true;
  global.define = __define;
  return module.exports;
});

$__System.registerDynamic("1b", ["2", "3", "4", "6", "8", "b", "5", "c", "f", "d", "e", "14", "15", "16", "17", "19", "13", "9", "1a"], true, function(require, exports, module) {
  ;
  var global = this,
      __define = global.define;
  global.define = undefined;
  'use strict';
  var $ = require("2"),
      global = require("3"),
      has = require("4"),
      DESCRIPTORS = require("6"),
      $def = require("8"),
      $redef = require("b"),
      $fails = require("5"),
      shared = require("c"),
      setToStringTag = require("f"),
      uid = require("d"),
      wks = require("e"),
      keyOf = require("14"),
      $names = require("15"),
      enumKeys = require("16"),
      isArray = require("17"),
      anObject = require("19"),
      toIObject = require("13"),
      createDesc = require("9"),
      getDesc = $.getDesc,
      setDesc = $.setDesc,
      _create = $.create,
      getNames = $names.get,
      $Symbol = global.Symbol,
      $JSON = global.JSON,
      _stringify = $JSON && $JSON.stringify,
      setter = false,
      HIDDEN = wks('_hidden'),
      isEnum = $.isEnum,
      SymbolRegistry = shared('symbol-registry'),
      AllSymbols = shared('symbols'),
      useNative = typeof $Symbol == 'function',
      ObjectProto = Object.prototype;
  var setSymbolDesc = DESCRIPTORS && $fails(function() {
    return _create(setDesc({}, 'a', {get: function() {
        return setDesc(this, 'a', {value: 7}).a;
      }})).a != 7;
  }) ? function(it, key, D) {
    var protoDesc = getDesc(ObjectProto, key);
    if (protoDesc)
      delete ObjectProto[key];
    setDesc(it, key, D);
    if (protoDesc && it !== ObjectProto)
      setDesc(ObjectProto, key, protoDesc);
  } : setDesc;
  var wrap = function(tag) {
    var sym = AllSymbols[tag] = _create($Symbol.prototype);
    sym._k = tag;
    DESCRIPTORS && setter && setSymbolDesc(ObjectProto, tag, {
      configurable: true,
      set: function(value) {
        if (has(this, HIDDEN) && has(this[HIDDEN], tag))
          this[HIDDEN][tag] = false;
        setSymbolDesc(this, tag, createDesc(1, value));
      }
    });
    return sym;
  };
  var isSymbol = function(it) {
    return typeof it == 'symbol';
  };
  var $defineProperty = function defineProperty(it, key, D) {
    if (D && has(AllSymbols, key)) {
      if (!D.enumerable) {
        if (!has(it, HIDDEN))
          setDesc(it, HIDDEN, createDesc(1, {}));
        it[HIDDEN][key] = true;
      } else {
        if (has(it, HIDDEN) && it[HIDDEN][key])
          it[HIDDEN][key] = false;
        D = _create(D, {enumerable: createDesc(0, false)});
      }
      return setSymbolDesc(it, key, D);
    }
    return setDesc(it, key, D);
  };
  var $defineProperties = function defineProperties(it, P) {
    anObject(it);
    var keys = enumKeys(P = toIObject(P)),
        i = 0,
        l = keys.length,
        key;
    while (l > i)
      $defineProperty(it, key = keys[i++], P[key]);
    return it;
  };
  var $create = function create(it, P) {
    return P === undefined ? _create(it) : $defineProperties(_create(it), P);
  };
  var $propertyIsEnumerable = function propertyIsEnumerable(key) {
    var E = isEnum.call(this, key);
    return E || !has(this, key) || !has(AllSymbols, key) || has(this, HIDDEN) && this[HIDDEN][key] ? E : true;
  };
  var $getOwnPropertyDescriptor = function getOwnPropertyDescriptor(it, key) {
    var D = getDesc(it = toIObject(it), key);
    if (D && has(AllSymbols, key) && !(has(it, HIDDEN) && it[HIDDEN][key]))
      D.enumerable = true;
    return D;
  };
  var $getOwnPropertyNames = function getOwnPropertyNames(it) {
    var names = getNames(toIObject(it)),
        result = [],
        i = 0,
        key;
    while (names.length > i)
      if (!has(AllSymbols, key = names[i++]) && key != HIDDEN)
        result.push(key);
    return result;
  };
  var $getOwnPropertySymbols = function getOwnPropertySymbols(it) {
    var names = getNames(toIObject(it)),
        result = [],
        i = 0,
        key;
    while (names.length > i)
      if (has(AllSymbols, key = names[i++]))
        result.push(AllSymbols[key]);
    return result;
  };
  var $stringify = function stringify(it) {
    if (it === undefined || isSymbol(it))
      return;
    var args = [it],
        i = 1,
        $$ = arguments,
        replacer,
        $replacer;
    while ($$.length > i)
      args.push($$[i++]);
    replacer = args[1];
    if (typeof replacer == 'function')
      $replacer = replacer;
    if ($replacer || !isArray(replacer))
      replacer = function(key, value) {
        if ($replacer)
          value = $replacer.call(this, key, value);
        if (!isSymbol(value))
          return value;
      };
    args[1] = replacer;
    return _stringify.apply($JSON, args);
  };
  var buggyJSON = $fails(function() {
    var S = $Symbol();
    return _stringify([S]) != '[null]' || _stringify({a: S}) != '{}' || _stringify(Object(S)) != '{}';
  });
  if (!useNative) {
    $Symbol = function Symbol() {
      if (isSymbol(this))
        throw TypeError('Symbol is not a constructor');
      return wrap(uid(arguments.length > 0 ? arguments[0] : undefined));
    };
    $redef($Symbol.prototype, 'toString', function toString() {
      return this._k;
    });
    isSymbol = function(it) {
      return it instanceof $Symbol;
    };
    $.create = $create;
    $.isEnum = $propertyIsEnumerable;
    $.getDesc = $getOwnPropertyDescriptor;
    $.setDesc = $defineProperty;
    $.setDescs = $defineProperties;
    $.getNames = $names.get = $getOwnPropertyNames;
    $.getSymbols = $getOwnPropertySymbols;
    if (DESCRIPTORS && !require("1a")) {
      $redef(ObjectProto, 'propertyIsEnumerable', $propertyIsEnumerable, true);
    }
  }
  var symbolStatics = {
    'for': function(key) {
      return has(SymbolRegistry, key += '') ? SymbolRegistry[key] : SymbolRegistry[key] = $Symbol(key);
    },
    keyFor: function keyFor(key) {
      return keyOf(SymbolRegistry, key);
    },
    useSetter: function() {
      setter = true;
    },
    useSimple: function() {
      setter = false;
    }
  };
  $.each.call(('hasInstance,isConcatSpreadable,iterator,match,replace,search,' + 'species,split,toPrimitive,toStringTag,unscopables').split(','), function(it) {
    var sym = wks(it);
    symbolStatics[it] = useNative ? sym : wrap(sym);
  });
  setter = true;
  $def($def.G + $def.W, {Symbol: $Symbol});
  $def($def.S, 'Symbol', symbolStatics);
  $def($def.S + $def.F * !useNative, 'Object', {
    create: $create,
    defineProperty: $defineProperty,
    defineProperties: $defineProperties,
    getOwnPropertyDescriptor: $getOwnPropertyDescriptor,
    getOwnPropertyNames: $getOwnPropertyNames,
    getOwnPropertySymbols: $getOwnPropertySymbols
  });
  $JSON && $def($def.S + $def.F * (!useNative || buggyJSON), 'JSON', {stringify: $stringify});
  setToStringTag($Symbol, 'Symbol');
  setToStringTag(Math, 'Math', true);
  setToStringTag(global.JSON, 'JSON', true);
  global.define = __define;
  return module.exports;
});

$__System.registerDynamic("1c", [], true, function(require, exports, module) {
  ;
  var global = this,
      __define = global.define;
  global.define = undefined;
  "format cjs";
  global.define = __define;
  return module.exports;
});

$__System.registerDynamic("1d", ["1b", "1c", "7"], true, function(require, exports, module) {
  ;
  var global = this,
      __define = global.define;
  global.define = undefined;
  require("1b");
  require("1c");
  module.exports = require("7").Symbol;
  global.define = __define;
  return module.exports;
});

$__System.registerDynamic("1e", ["1d"], true, function(require, exports, module) {
  ;
  var global = this,
      __define = global.define;
  global.define = undefined;
  module.exports = require("1d");
  global.define = __define;
  return module.exports;
});

$__System.registerDynamic("1f", ["1e"], true, function(require, exports, module) {
  ;
  var global = this,
      __define = global.define;
  global.define = undefined;
  module.exports = {
    "default": require("1e"),
    __esModule: true
  };
  global.define = __define;
  return module.exports;
});

$__System.registerDynamic("22", ["2"], true, function(require, exports, module) {
  ;
  var global = this,
      __define = global.define;
  global.define = undefined;
  var $ = require("2");
  module.exports = function defineProperty(it, key, desc) {
    return $.setDesc(it, key, desc);
  };
  global.define = __define;
  return module.exports;
});

$__System.registerDynamic("23", ["22"], true, function(require, exports, module) {
  ;
  var global = this,
      __define = global.define;
  global.define = undefined;
  module.exports = {
    "default": require("22"),
    __esModule: true
  };
  global.define = __define;
  return module.exports;
});

$__System.registerDynamic("24", ["23"], true, function(require, exports, module) {
  ;
  var global = this,
      __define = global.define;
  global.define = undefined;
  "use strict";
  var _Object$defineProperty = require("23")["default"];
  exports["default"] = (function() {
    function defineProperties(target, props) {
      for (var i = 0; i < props.length; i++) {
        var descriptor = props[i];
        descriptor.enumerable = descriptor.enumerable || false;
        descriptor.configurable = true;
        if ("value" in descriptor)
          descriptor.writable = true;
        _Object$defineProperty(target, descriptor.key, descriptor);
      }
    }
    return function(Constructor, protoProps, staticProps) {
      if (protoProps)
        defineProperties(Constructor.prototype, protoProps);
      if (staticProps)
        defineProperties(Constructor, staticProps);
      return Constructor;
    };
  })();
  exports.__esModule = true;
  global.define = __define;
  return module.exports;
});

$__System.registerDynamic("25", [], true, function(require, exports, module) {
  ;
  var global = this,
      __define = global.define;
  global.define = undefined;
  "use strict";
  exports["default"] = function(instance, Constructor) {
    if (!(instance instanceof Constructor)) {
      throw new TypeError("Cannot call a class as a function");
    }
  };
  exports.__esModule = true;
  global.define = __define;
  return module.exports;
});

$__System.registerDynamic("26", [], true, function(require, exports, module) {
  ;
  var global = this,
      __define = global.define;
  global.define = undefined;
  var lookup = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  ;
  (function(exports) {
    'use strict';
    var Arr = (typeof Uint8Array !== 'undefined') ? Uint8Array : Array;
    var PLUS = '+'.charCodeAt(0);
    var SLASH = '/'.charCodeAt(0);
    var NUMBER = '0'.charCodeAt(0);
    var LOWER = 'a'.charCodeAt(0);
    var UPPER = 'A'.charCodeAt(0);
    var PLUS_URL_SAFE = '-'.charCodeAt(0);
    var SLASH_URL_SAFE = '_'.charCodeAt(0);
    function decode(elt) {
      var code = elt.charCodeAt(0);
      if (code === PLUS || code === PLUS_URL_SAFE)
        return 62;
      if (code === SLASH || code === SLASH_URL_SAFE)
        return 63;
      if (code < NUMBER)
        return -1;
      if (code < NUMBER + 10)
        return code - NUMBER + 26 + 26;
      if (code < UPPER + 26)
        return code - UPPER;
      if (code < LOWER + 26)
        return code - LOWER + 26;
    }
    function b64ToByteArray(b64) {
      var i,
          j,
          l,
          tmp,
          placeHolders,
          arr;
      if (b64.length % 4 > 0) {
        throw new Error('Invalid string. Length must be a multiple of 4');
      }
      var len = b64.length;
      placeHolders = '=' === b64.charAt(len - 2) ? 2 : '=' === b64.charAt(len - 1) ? 1 : 0;
      arr = new Arr(b64.length * 3 / 4 - placeHolders);
      l = placeHolders > 0 ? b64.length - 4 : b64.length;
      var L = 0;
      function push(v) {
        arr[L++] = v;
      }
      for (i = 0, j = 0; i < l; i += 4, j += 3) {
        tmp = (decode(b64.charAt(i)) << 18) | (decode(b64.charAt(i + 1)) << 12) | (decode(b64.charAt(i + 2)) << 6) | decode(b64.charAt(i + 3));
        push((tmp & 0xFF0000) >> 16);
        push((tmp & 0xFF00) >> 8);
        push(tmp & 0xFF);
      }
      if (placeHolders === 2) {
        tmp = (decode(b64.charAt(i)) << 2) | (decode(b64.charAt(i + 1)) >> 4);
        push(tmp & 0xFF);
      } else if (placeHolders === 1) {
        tmp = (decode(b64.charAt(i)) << 10) | (decode(b64.charAt(i + 1)) << 4) | (decode(b64.charAt(i + 2)) >> 2);
        push((tmp >> 8) & 0xFF);
        push(tmp & 0xFF);
      }
      return arr;
    }
    function uint8ToBase64(uint8) {
      var i,
          extraBytes = uint8.length % 3,
          output = "",
          temp,
          length;
      function encode(num) {
        return lookup.charAt(num);
      }
      function tripletToBase64(num) {
        return encode(num >> 18 & 0x3F) + encode(num >> 12 & 0x3F) + encode(num >> 6 & 0x3F) + encode(num & 0x3F);
      }
      for (i = 0, length = uint8.length - extraBytes; i < length; i += 3) {
        temp = (uint8[i] << 16) + (uint8[i + 1] << 8) + (uint8[i + 2]);
        output += tripletToBase64(temp);
      }
      switch (extraBytes) {
        case 1:
          temp = uint8[uint8.length - 1];
          output += encode(temp >> 2);
          output += encode((temp << 4) & 0x3F);
          output += '==';
          break;
        case 2:
          temp = (uint8[uint8.length - 2] << 8) + (uint8[uint8.length - 1]);
          output += encode(temp >> 10);
          output += encode((temp >> 4) & 0x3F);
          output += encode((temp << 2) & 0x3F);
          output += '=';
          break;
      }
      return output;
    }
    exports.toByteArray = b64ToByteArray;
    exports.fromByteArray = uint8ToBase64;
  }(typeof exports === 'undefined' ? (this.base64js = {}) : exports));
  global.define = __define;
  return module.exports;
});

$__System.registerDynamic("27", ["26"], true, function(require, exports, module) {
  ;
  var global = this,
      __define = global.define;
  global.define = undefined;
  module.exports = require("26");
  global.define = __define;
  return module.exports;
});

$__System.registerDynamic("28", [], true, function(require, exports, module) {
  ;
  var global = this,
      __define = global.define;
  global.define = undefined;
  exports.read = function(buffer, offset, isLE, mLen, nBytes) {
    var e,
        m;
    var eLen = nBytes * 8 - mLen - 1;
    var eMax = (1 << eLen) - 1;
    var eBias = eMax >> 1;
    var nBits = -7;
    var i = isLE ? (nBytes - 1) : 0;
    var d = isLE ? -1 : 1;
    var s = buffer[offset + i];
    i += d;
    e = s & ((1 << (-nBits)) - 1);
    s >>= (-nBits);
    nBits += eLen;
    for (; nBits > 0; e = e * 256 + buffer[offset + i], i += d, nBits -= 8) {}
    m = e & ((1 << (-nBits)) - 1);
    e >>= (-nBits);
    nBits += mLen;
    for (; nBits > 0; m = m * 256 + buffer[offset + i], i += d, nBits -= 8) {}
    if (e === 0) {
      e = 1 - eBias;
    } else if (e === eMax) {
      return m ? NaN : ((s ? -1 : 1) * Infinity);
    } else {
      m = m + Math.pow(2, mLen);
      e = e - eBias;
    }
    return (s ? -1 : 1) * m * Math.pow(2, e - mLen);
  };
  exports.write = function(buffer, value, offset, isLE, mLen, nBytes) {
    var e,
        m,
        c;
    var eLen = nBytes * 8 - mLen - 1;
    var eMax = (1 << eLen) - 1;
    var eBias = eMax >> 1;
    var rt = (mLen === 23 ? Math.pow(2, -24) - Math.pow(2, -77) : 0);
    var i = isLE ? 0 : (nBytes - 1);
    var d = isLE ? 1 : -1;
    var s = value < 0 || (value === 0 && 1 / value < 0) ? 1 : 0;
    value = Math.abs(value);
    if (isNaN(value) || value === Infinity) {
      m = isNaN(value) ? 1 : 0;
      e = eMax;
    } else {
      e = Math.floor(Math.log(value) / Math.LN2);
      if (value * (c = Math.pow(2, -e)) < 1) {
        e--;
        c *= 2;
      }
      if (e + eBias >= 1) {
        value += rt / c;
      } else {
        value += rt * Math.pow(2, 1 - eBias);
      }
      if (value * c >= 2) {
        e++;
        c /= 2;
      }
      if (e + eBias >= eMax) {
        m = 0;
        e = eMax;
      } else if (e + eBias >= 1) {
        m = (value * c - 1) * Math.pow(2, mLen);
        e = e + eBias;
      } else {
        m = value * Math.pow(2, eBias - 1) * Math.pow(2, mLen);
        e = 0;
      }
    }
    for (; mLen >= 8; buffer[offset + i] = m & 0xff, i += d, m /= 256, mLen -= 8) {}
    e = (e << mLen) | m;
    eLen += mLen;
    for (; eLen > 0; buffer[offset + i] = e & 0xff, i += d, e /= 256, eLen -= 8) {}
    buffer[offset + i - d] |= s * 128;
  };
  global.define = __define;
  return module.exports;
});

$__System.registerDynamic("29", ["28"], true, function(require, exports, module) {
  ;
  var global = this,
      __define = global.define;
  global.define = undefined;
  module.exports = require("28");
  global.define = __define;
  return module.exports;
});

$__System.registerDynamic("2a", [], true, function(require, exports, module) {
  ;
  var global = this,
      __define = global.define;
  global.define = undefined;
  var isArray = Array.isArray;
  var str = Object.prototype.toString;
  module.exports = isArray || function(val) {
    return !!val && '[object Array]' == str.call(val);
  };
  global.define = __define;
  return module.exports;
});

$__System.registerDynamic("2b", ["2a"], true, function(require, exports, module) {
  ;
  var global = this,
      __define = global.define;
  global.define = undefined;
  module.exports = require("2a");
  global.define = __define;
  return module.exports;
});

$__System.registerDynamic("2c", ["27", "29", "2b"], true, function(require, exports, module) {
  ;
  var global = this,
      __define = global.define;
  global.define = undefined;
  var base64 = require("27");
  var ieee754 = require("29");
  var isArray = require("2b");
  exports.Buffer = Buffer;
  exports.SlowBuffer = SlowBuffer;
  exports.INSPECT_MAX_BYTES = 50;
  Buffer.poolSize = 8192;
  var rootParent = {};
  Buffer.TYPED_ARRAY_SUPPORT = global.TYPED_ARRAY_SUPPORT !== undefined ? global.TYPED_ARRAY_SUPPORT : typedArraySupport();
  function typedArraySupport() {
    function Bar() {}
    try {
      var arr = new Uint8Array(1);
      arr.foo = function() {
        return 42;
      };
      arr.constructor = Bar;
      return arr.foo() === 42 && arr.constructor === Bar && typeof arr.subarray === 'function' && arr.subarray(1, 1).byteLength === 0;
    } catch (e) {
      return false;
    }
  }
  function kMaxLength() {
    return Buffer.TYPED_ARRAY_SUPPORT ? 0x7fffffff : 0x3fffffff;
  }
  function Buffer(arg) {
    if (!(this instanceof Buffer)) {
      if (arguments.length > 1)
        return new Buffer(arg, arguments[1]);
      return new Buffer(arg);
    }
    this.length = 0;
    this.parent = undefined;
    if (typeof arg === 'number') {
      return fromNumber(this, arg);
    }
    if (typeof arg === 'string') {
      return fromString(this, arg, arguments.length > 1 ? arguments[1] : 'utf8');
    }
    return fromObject(this, arg);
  }
  function fromNumber(that, length) {
    that = allocate(that, length < 0 ? 0 : checked(length) | 0);
    if (!Buffer.TYPED_ARRAY_SUPPORT) {
      for (var i = 0; i < length; i++) {
        that[i] = 0;
      }
    }
    return that;
  }
  function fromString(that, string, encoding) {
    if (typeof encoding !== 'string' || encoding === '')
      encoding = 'utf8';
    var length = byteLength(string, encoding) | 0;
    that = allocate(that, length);
    that.write(string, encoding);
    return that;
  }
  function fromObject(that, object) {
    if (Buffer.isBuffer(object))
      return fromBuffer(that, object);
    if (isArray(object))
      return fromArray(that, object);
    if (object == null) {
      throw new TypeError('must start with number, buffer, array or string');
    }
    if (typeof ArrayBuffer !== 'undefined') {
      if (object.buffer instanceof ArrayBuffer) {
        return fromTypedArray(that, object);
      }
      if (object instanceof ArrayBuffer) {
        return fromArrayBuffer(that, object);
      }
    }
    if (object.length)
      return fromArrayLike(that, object);
    return fromJsonObject(that, object);
  }
  function fromBuffer(that, buffer) {
    var length = checked(buffer.length) | 0;
    that = allocate(that, length);
    buffer.copy(that, 0, 0, length);
    return that;
  }
  function fromArray(that, array) {
    var length = checked(array.length) | 0;
    that = allocate(that, length);
    for (var i = 0; i < length; i += 1) {
      that[i] = array[i] & 255;
    }
    return that;
  }
  function fromTypedArray(that, array) {
    var length = checked(array.length) | 0;
    that = allocate(that, length);
    for (var i = 0; i < length; i += 1) {
      that[i] = array[i] & 255;
    }
    return that;
  }
  function fromArrayBuffer(that, array) {
    if (Buffer.TYPED_ARRAY_SUPPORT) {
      array.byteLength;
      that = Buffer._augment(new Uint8Array(array));
    } else {
      that = fromTypedArray(that, new Uint8Array(array));
    }
    return that;
  }
  function fromArrayLike(that, array) {
    var length = checked(array.length) | 0;
    that = allocate(that, length);
    for (var i = 0; i < length; i += 1) {
      that[i] = array[i] & 255;
    }
    return that;
  }
  function fromJsonObject(that, object) {
    var array;
    var length = 0;
    if (object.type === 'Buffer' && isArray(object.data)) {
      array = object.data;
      length = checked(array.length) | 0;
    }
    that = allocate(that, length);
    for (var i = 0; i < length; i += 1) {
      that[i] = array[i] & 255;
    }
    return that;
  }
  if (Buffer.TYPED_ARRAY_SUPPORT) {
    Buffer.prototype.__proto__ = Uint8Array.prototype;
    Buffer.__proto__ = Uint8Array;
  }
  function allocate(that, length) {
    if (Buffer.TYPED_ARRAY_SUPPORT) {
      that = Buffer._augment(new Uint8Array(length));
      that.__proto__ = Buffer.prototype;
    } else {
      that.length = length;
      that._isBuffer = true;
    }
    var fromPool = length !== 0 && length <= Buffer.poolSize >>> 1;
    if (fromPool)
      that.parent = rootParent;
    return that;
  }
  function checked(length) {
    if (length >= kMaxLength()) {
      throw new RangeError('Attempt to allocate Buffer larger than maximum ' + 'size: 0x' + kMaxLength().toString(16) + ' bytes');
    }
    return length | 0;
  }
  function SlowBuffer(subject, encoding) {
    if (!(this instanceof SlowBuffer))
      return new SlowBuffer(subject, encoding);
    var buf = new Buffer(subject, encoding);
    delete buf.parent;
    return buf;
  }
  Buffer.isBuffer = function isBuffer(b) {
    return !!(b != null && b._isBuffer);
  };
  Buffer.compare = function compare(a, b) {
    if (!Buffer.isBuffer(a) || !Buffer.isBuffer(b)) {
      throw new TypeError('Arguments must be Buffers');
    }
    if (a === b)
      return 0;
    var x = a.length;
    var y = b.length;
    var i = 0;
    var len = Math.min(x, y);
    while (i < len) {
      if (a[i] !== b[i])
        break;
      ++i;
    }
    if (i !== len) {
      x = a[i];
      y = b[i];
    }
    if (x < y)
      return -1;
    if (y < x)
      return 1;
    return 0;
  };
  Buffer.isEncoding = function isEncoding(encoding) {
    switch (String(encoding).toLowerCase()) {
      case 'hex':
      case 'utf8':
      case 'utf-8':
      case 'ascii':
      case 'binary':
      case 'base64':
      case 'raw':
      case 'ucs2':
      case 'ucs-2':
      case 'utf16le':
      case 'utf-16le':
        return true;
      default:
        return false;
    }
  };
  Buffer.concat = function concat(list, length) {
    if (!isArray(list))
      throw new TypeError('list argument must be an Array of Buffers.');
    if (list.length === 0) {
      return new Buffer(0);
    }
    var i;
    if (length === undefined) {
      length = 0;
      for (i = 0; i < list.length; i++) {
        length += list[i].length;
      }
    }
    var buf = new Buffer(length);
    var pos = 0;
    for (i = 0; i < list.length; i++) {
      var item = list[i];
      item.copy(buf, pos);
      pos += item.length;
    }
    return buf;
  };
  function byteLength(string, encoding) {
    if (typeof string !== 'string')
      string = '' + string;
    var len = string.length;
    if (len === 0)
      return 0;
    var loweredCase = false;
    for (; ; ) {
      switch (encoding) {
        case 'ascii':
        case 'binary':
        case 'raw':
        case 'raws':
          return len;
        case 'utf8':
        case 'utf-8':
          return utf8ToBytes(string).length;
        case 'ucs2':
        case 'ucs-2':
        case 'utf16le':
        case 'utf-16le':
          return len * 2;
        case 'hex':
          return len >>> 1;
        case 'base64':
          return base64ToBytes(string).length;
        default:
          if (loweredCase)
            return utf8ToBytes(string).length;
          encoding = ('' + encoding).toLowerCase();
          loweredCase = true;
      }
    }
  }
  Buffer.byteLength = byteLength;
  Buffer.prototype.length = undefined;
  Buffer.prototype.parent = undefined;
  function slowToString(encoding, start, end) {
    var loweredCase = false;
    start = start | 0;
    end = end === undefined || end === Infinity ? this.length : end | 0;
    if (!encoding)
      encoding = 'utf8';
    if (start < 0)
      start = 0;
    if (end > this.length)
      end = this.length;
    if (end <= start)
      return '';
    while (true) {
      switch (encoding) {
        case 'hex':
          return hexSlice(this, start, end);
        case 'utf8':
        case 'utf-8':
          return utf8Slice(this, start, end);
        case 'ascii':
          return asciiSlice(this, start, end);
        case 'binary':
          return binarySlice(this, start, end);
        case 'base64':
          return base64Slice(this, start, end);
        case 'ucs2':
        case 'ucs-2':
        case 'utf16le':
        case 'utf-16le':
          return utf16leSlice(this, start, end);
        default:
          if (loweredCase)
            throw new TypeError('Unknown encoding: ' + encoding);
          encoding = (encoding + '').toLowerCase();
          loweredCase = true;
      }
    }
  }
  Buffer.prototype.toString = function toString() {
    var length = this.length | 0;
    if (length === 0)
      return '';
    if (arguments.length === 0)
      return utf8Slice(this, 0, length);
    return slowToString.apply(this, arguments);
  };
  Buffer.prototype.equals = function equals(b) {
    if (!Buffer.isBuffer(b))
      throw new TypeError('Argument must be a Buffer');
    if (this === b)
      return true;
    return Buffer.compare(this, b) === 0;
  };
  Buffer.prototype.inspect = function inspect() {
    var str = '';
    var max = exports.INSPECT_MAX_BYTES;
    if (this.length > 0) {
      str = this.toString('hex', 0, max).match(/.{2}/g).join(' ');
      if (this.length > max)
        str += ' ... ';
    }
    return '<Buffer ' + str + '>';
  };
  Buffer.prototype.compare = function compare(b) {
    if (!Buffer.isBuffer(b))
      throw new TypeError('Argument must be a Buffer');
    if (this === b)
      return 0;
    return Buffer.compare(this, b);
  };
  Buffer.prototype.indexOf = function indexOf(val, byteOffset) {
    if (byteOffset > 0x7fffffff)
      byteOffset = 0x7fffffff;
    else if (byteOffset < -0x80000000)
      byteOffset = -0x80000000;
    byteOffset >>= 0;
    if (this.length === 0)
      return -1;
    if (byteOffset >= this.length)
      return -1;
    if (byteOffset < 0)
      byteOffset = Math.max(this.length + byteOffset, 0);
    if (typeof val === 'string') {
      if (val.length === 0)
        return -1;
      return String.prototype.indexOf.call(this, val, byteOffset);
    }
    if (Buffer.isBuffer(val)) {
      return arrayIndexOf(this, val, byteOffset);
    }
    if (typeof val === 'number') {
      if (Buffer.TYPED_ARRAY_SUPPORT && Uint8Array.prototype.indexOf === 'function') {
        return Uint8Array.prototype.indexOf.call(this, val, byteOffset);
      }
      return arrayIndexOf(this, [val], byteOffset);
    }
    function arrayIndexOf(arr, val, byteOffset) {
      var foundIndex = -1;
      for (var i = 0; byteOffset + i < arr.length; i++) {
        if (arr[byteOffset + i] === val[foundIndex === -1 ? 0 : i - foundIndex]) {
          if (foundIndex === -1)
            foundIndex = i;
          if (i - foundIndex + 1 === val.length)
            return byteOffset + foundIndex;
        } else {
          foundIndex = -1;
        }
      }
      return -1;
    }
    throw new TypeError('val must be string, number or Buffer');
  };
  Buffer.prototype.get = function get(offset) {
    console.log('.get() is deprecated. Access using array indexes instead.');
    return this.readUInt8(offset);
  };
  Buffer.prototype.set = function set(v, offset) {
    console.log('.set() is deprecated. Access using array indexes instead.');
    return this.writeUInt8(v, offset);
  };
  function hexWrite(buf, string, offset, length) {
    offset = Number(offset) || 0;
    var remaining = buf.length - offset;
    if (!length) {
      length = remaining;
    } else {
      length = Number(length);
      if (length > remaining) {
        length = remaining;
      }
    }
    var strLen = string.length;
    if (strLen % 2 !== 0)
      throw new Error('Invalid hex string');
    if (length > strLen / 2) {
      length = strLen / 2;
    }
    for (var i = 0; i < length; i++) {
      var parsed = parseInt(string.substr(i * 2, 2), 16);
      if (isNaN(parsed))
        throw new Error('Invalid hex string');
      buf[offset + i] = parsed;
    }
    return i;
  }
  function utf8Write(buf, string, offset, length) {
    return blitBuffer(utf8ToBytes(string, buf.length - offset), buf, offset, length);
  }
  function asciiWrite(buf, string, offset, length) {
    return blitBuffer(asciiToBytes(string), buf, offset, length);
  }
  function binaryWrite(buf, string, offset, length) {
    return asciiWrite(buf, string, offset, length);
  }
  function base64Write(buf, string, offset, length) {
    return blitBuffer(base64ToBytes(string), buf, offset, length);
  }
  function ucs2Write(buf, string, offset, length) {
    return blitBuffer(utf16leToBytes(string, buf.length - offset), buf, offset, length);
  }
  Buffer.prototype.write = function write(string, offset, length, encoding) {
    if (offset === undefined) {
      encoding = 'utf8';
      length = this.length;
      offset = 0;
    } else if (length === undefined && typeof offset === 'string') {
      encoding = offset;
      length = this.length;
      offset = 0;
    } else if (isFinite(offset)) {
      offset = offset | 0;
      if (isFinite(length)) {
        length = length | 0;
        if (encoding === undefined)
          encoding = 'utf8';
      } else {
        encoding = length;
        length = undefined;
      }
    } else {
      var swap = encoding;
      encoding = offset;
      offset = length | 0;
      length = swap;
    }
    var remaining = this.length - offset;
    if (length === undefined || length > remaining)
      length = remaining;
    if ((string.length > 0 && (length < 0 || offset < 0)) || offset > this.length) {
      throw new RangeError('attempt to write outside buffer bounds');
    }
    if (!encoding)
      encoding = 'utf8';
    var loweredCase = false;
    for (; ; ) {
      switch (encoding) {
        case 'hex':
          return hexWrite(this, string, offset, length);
        case 'utf8':
        case 'utf-8':
          return utf8Write(this, string, offset, length);
        case 'ascii':
          return asciiWrite(this, string, offset, length);
        case 'binary':
          return binaryWrite(this, string, offset, length);
        case 'base64':
          return base64Write(this, string, offset, length);
        case 'ucs2':
        case 'ucs-2':
        case 'utf16le':
        case 'utf-16le':
          return ucs2Write(this, string, offset, length);
        default:
          if (loweredCase)
            throw new TypeError('Unknown encoding: ' + encoding);
          encoding = ('' + encoding).toLowerCase();
          loweredCase = true;
      }
    }
  };
  Buffer.prototype.toJSON = function toJSON() {
    return {
      type: 'Buffer',
      data: Array.prototype.slice.call(this._arr || this, 0)
    };
  };
  function base64Slice(buf, start, end) {
    if (start === 0 && end === buf.length) {
      return base64.fromByteArray(buf);
    } else {
      return base64.fromByteArray(buf.slice(start, end));
    }
  }
  function utf8Slice(buf, start, end) {
    end = Math.min(buf.length, end);
    var res = [];
    var i = start;
    while (i < end) {
      var firstByte = buf[i];
      var codePoint = null;
      var bytesPerSequence = (firstByte > 0xEF) ? 4 : (firstByte > 0xDF) ? 3 : (firstByte > 0xBF) ? 2 : 1;
      if (i + bytesPerSequence <= end) {
        var secondByte,
            thirdByte,
            fourthByte,
            tempCodePoint;
        switch (bytesPerSequence) {
          case 1:
            if (firstByte < 0x80) {
              codePoint = firstByte;
            }
            break;
          case 2:
            secondByte = buf[i + 1];
            if ((secondByte & 0xC0) === 0x80) {
              tempCodePoint = (firstByte & 0x1F) << 0x6 | (secondByte & 0x3F);
              if (tempCodePoint > 0x7F) {
                codePoint = tempCodePoint;
              }
            }
            break;
          case 3:
            secondByte = buf[i + 1];
            thirdByte = buf[i + 2];
            if ((secondByte & 0xC0) === 0x80 && (thirdByte & 0xC0) === 0x80) {
              tempCodePoint = (firstByte & 0xF) << 0xC | (secondByte & 0x3F) << 0x6 | (thirdByte & 0x3F);
              if (tempCodePoint > 0x7FF && (tempCodePoint < 0xD800 || tempCodePoint > 0xDFFF)) {
                codePoint = tempCodePoint;
              }
            }
            break;
          case 4:
            secondByte = buf[i + 1];
            thirdByte = buf[i + 2];
            fourthByte = buf[i + 3];
            if ((secondByte & 0xC0) === 0x80 && (thirdByte & 0xC0) === 0x80 && (fourthByte & 0xC0) === 0x80) {
              tempCodePoint = (firstByte & 0xF) << 0x12 | (secondByte & 0x3F) << 0xC | (thirdByte & 0x3F) << 0x6 | (fourthByte & 0x3F);
              if (tempCodePoint > 0xFFFF && tempCodePoint < 0x110000) {
                codePoint = tempCodePoint;
              }
            }
        }
      }
      if (codePoint === null) {
        codePoint = 0xFFFD;
        bytesPerSequence = 1;
      } else if (codePoint > 0xFFFF) {
        codePoint -= 0x10000;
        res.push(codePoint >>> 10 & 0x3FF | 0xD800);
        codePoint = 0xDC00 | codePoint & 0x3FF;
      }
      res.push(codePoint);
      i += bytesPerSequence;
    }
    return decodeCodePointsArray(res);
  }
  var MAX_ARGUMENTS_LENGTH = 0x1000;
  function decodeCodePointsArray(codePoints) {
    var len = codePoints.length;
    if (len <= MAX_ARGUMENTS_LENGTH) {
      return String.fromCharCode.apply(String, codePoints);
    }
    var res = '';
    var i = 0;
    while (i < len) {
      res += String.fromCharCode.apply(String, codePoints.slice(i, i += MAX_ARGUMENTS_LENGTH));
    }
    return res;
  }
  function asciiSlice(buf, start, end) {
    var ret = '';
    end = Math.min(buf.length, end);
    for (var i = start; i < end; i++) {
      ret += String.fromCharCode(buf[i] & 0x7F);
    }
    return ret;
  }
  function binarySlice(buf, start, end) {
    var ret = '';
    end = Math.min(buf.length, end);
    for (var i = start; i < end; i++) {
      ret += String.fromCharCode(buf[i]);
    }
    return ret;
  }
  function hexSlice(buf, start, end) {
    var len = buf.length;
    if (!start || start < 0)
      start = 0;
    if (!end || end < 0 || end > len)
      end = len;
    var out = '';
    for (var i = start; i < end; i++) {
      out += toHex(buf[i]);
    }
    return out;
  }
  function utf16leSlice(buf, start, end) {
    var bytes = buf.slice(start, end);
    var res = '';
    for (var i = 0; i < bytes.length; i += 2) {
      res += String.fromCharCode(bytes[i] + bytes[i + 1] * 256);
    }
    return res;
  }
  Buffer.prototype.slice = function slice(start, end) {
    var len = this.length;
    start = ~~start;
    end = end === undefined ? len : ~~end;
    if (start < 0) {
      start += len;
      if (start < 0)
        start = 0;
    } else if (start > len) {
      start = len;
    }
    if (end < 0) {
      end += len;
      if (end < 0)
        end = 0;
    } else if (end > len) {
      end = len;
    }
    if (end < start)
      end = start;
    var newBuf;
    if (Buffer.TYPED_ARRAY_SUPPORT) {
      newBuf = Buffer._augment(this.subarray(start, end));
    } else {
      var sliceLen = end - start;
      newBuf = new Buffer(sliceLen, undefined);
      for (var i = 0; i < sliceLen; i++) {
        newBuf[i] = this[i + start];
      }
    }
    if (newBuf.length)
      newBuf.parent = this.parent || this;
    return newBuf;
  };
  function checkOffset(offset, ext, length) {
    if ((offset % 1) !== 0 || offset < 0)
      throw new RangeError('offset is not uint');
    if (offset + ext > length)
      throw new RangeError('Trying to access beyond buffer length');
  }
  Buffer.prototype.readUIntLE = function readUIntLE(offset, byteLength, noAssert) {
    offset = offset | 0;
    byteLength = byteLength | 0;
    if (!noAssert)
      checkOffset(offset, byteLength, this.length);
    var val = this[offset];
    var mul = 1;
    var i = 0;
    while (++i < byteLength && (mul *= 0x100)) {
      val += this[offset + i] * mul;
    }
    return val;
  };
  Buffer.prototype.readUIntBE = function readUIntBE(offset, byteLength, noAssert) {
    offset = offset | 0;
    byteLength = byteLength | 0;
    if (!noAssert) {
      checkOffset(offset, byteLength, this.length);
    }
    var val = this[offset + --byteLength];
    var mul = 1;
    while (byteLength > 0 && (mul *= 0x100)) {
      val += this[offset + --byteLength] * mul;
    }
    return val;
  };
  Buffer.prototype.readUInt8 = function readUInt8(offset, noAssert) {
    if (!noAssert)
      checkOffset(offset, 1, this.length);
    return this[offset];
  };
  Buffer.prototype.readUInt16LE = function readUInt16LE(offset, noAssert) {
    if (!noAssert)
      checkOffset(offset, 2, this.length);
    return this[offset] | (this[offset + 1] << 8);
  };
  Buffer.prototype.readUInt16BE = function readUInt16BE(offset, noAssert) {
    if (!noAssert)
      checkOffset(offset, 2, this.length);
    return (this[offset] << 8) | this[offset + 1];
  };
  Buffer.prototype.readUInt32LE = function readUInt32LE(offset, noAssert) {
    if (!noAssert)
      checkOffset(offset, 4, this.length);
    return ((this[offset]) | (this[offset + 1] << 8) | (this[offset + 2] << 16)) + (this[offset + 3] * 0x1000000);
  };
  Buffer.prototype.readUInt32BE = function readUInt32BE(offset, noAssert) {
    if (!noAssert)
      checkOffset(offset, 4, this.length);
    return (this[offset] * 0x1000000) + ((this[offset + 1] << 16) | (this[offset + 2] << 8) | this[offset + 3]);
  };
  Buffer.prototype.readIntLE = function readIntLE(offset, byteLength, noAssert) {
    offset = offset | 0;
    byteLength = byteLength | 0;
    if (!noAssert)
      checkOffset(offset, byteLength, this.length);
    var val = this[offset];
    var mul = 1;
    var i = 0;
    while (++i < byteLength && (mul *= 0x100)) {
      val += this[offset + i] * mul;
    }
    mul *= 0x80;
    if (val >= mul)
      val -= Math.pow(2, 8 * byteLength);
    return val;
  };
  Buffer.prototype.readIntBE = function readIntBE(offset, byteLength, noAssert) {
    offset = offset | 0;
    byteLength = byteLength | 0;
    if (!noAssert)
      checkOffset(offset, byteLength, this.length);
    var i = byteLength;
    var mul = 1;
    var val = this[offset + --i];
    while (i > 0 && (mul *= 0x100)) {
      val += this[offset + --i] * mul;
    }
    mul *= 0x80;
    if (val >= mul)
      val -= Math.pow(2, 8 * byteLength);
    return val;
  };
  Buffer.prototype.readInt8 = function readInt8(offset, noAssert) {
    if (!noAssert)
      checkOffset(offset, 1, this.length);
    if (!(this[offset] & 0x80))
      return (this[offset]);
    return ((0xff - this[offset] + 1) * -1);
  };
  Buffer.prototype.readInt16LE = function readInt16LE(offset, noAssert) {
    if (!noAssert)
      checkOffset(offset, 2, this.length);
    var val = this[offset] | (this[offset + 1] << 8);
    return (val & 0x8000) ? val | 0xFFFF0000 : val;
  };
  Buffer.prototype.readInt16BE = function readInt16BE(offset, noAssert) {
    if (!noAssert)
      checkOffset(offset, 2, this.length);
    var val = this[offset + 1] | (this[offset] << 8);
    return (val & 0x8000) ? val | 0xFFFF0000 : val;
  };
  Buffer.prototype.readInt32LE = function readInt32LE(offset, noAssert) {
    if (!noAssert)
      checkOffset(offset, 4, this.length);
    return (this[offset]) | (this[offset + 1] << 8) | (this[offset + 2] << 16) | (this[offset + 3] << 24);
  };
  Buffer.prototype.readInt32BE = function readInt32BE(offset, noAssert) {
    if (!noAssert)
      checkOffset(offset, 4, this.length);
    return (this[offset] << 24) | (this[offset + 1] << 16) | (this[offset + 2] << 8) | (this[offset + 3]);
  };
  Buffer.prototype.readFloatLE = function readFloatLE(offset, noAssert) {
    if (!noAssert)
      checkOffset(offset, 4, this.length);
    return ieee754.read(this, offset, true, 23, 4);
  };
  Buffer.prototype.readFloatBE = function readFloatBE(offset, noAssert) {
    if (!noAssert)
      checkOffset(offset, 4, this.length);
    return ieee754.read(this, offset, false, 23, 4);
  };
  Buffer.prototype.readDoubleLE = function readDoubleLE(offset, noAssert) {
    if (!noAssert)
      checkOffset(offset, 8, this.length);
    return ieee754.read(this, offset, true, 52, 8);
  };
  Buffer.prototype.readDoubleBE = function readDoubleBE(offset, noAssert) {
    if (!noAssert)
      checkOffset(offset, 8, this.length);
    return ieee754.read(this, offset, false, 52, 8);
  };
  function checkInt(buf, value, offset, ext, max, min) {
    if (!Buffer.isBuffer(buf))
      throw new TypeError('buffer must be a Buffer instance');
    if (value > max || value < min)
      throw new RangeError('value is out of bounds');
    if (offset + ext > buf.length)
      throw new RangeError('index out of range');
  }
  Buffer.prototype.writeUIntLE = function writeUIntLE(value, offset, byteLength, noAssert) {
    value = +value;
    offset = offset | 0;
    byteLength = byteLength | 0;
    if (!noAssert)
      checkInt(this, value, offset, byteLength, Math.pow(2, 8 * byteLength), 0);
    var mul = 1;
    var i = 0;
    this[offset] = value & 0xFF;
    while (++i < byteLength && (mul *= 0x100)) {
      this[offset + i] = (value / mul) & 0xFF;
    }
    return offset + byteLength;
  };
  Buffer.prototype.writeUIntBE = function writeUIntBE(value, offset, byteLength, noAssert) {
    value = +value;
    offset = offset | 0;
    byteLength = byteLength | 0;
    if (!noAssert)
      checkInt(this, value, offset, byteLength, Math.pow(2, 8 * byteLength), 0);
    var i = byteLength - 1;
    var mul = 1;
    this[offset + i] = value & 0xFF;
    while (--i >= 0 && (mul *= 0x100)) {
      this[offset + i] = (value / mul) & 0xFF;
    }
    return offset + byteLength;
  };
  Buffer.prototype.writeUInt8 = function writeUInt8(value, offset, noAssert) {
    value = +value;
    offset = offset | 0;
    if (!noAssert)
      checkInt(this, value, offset, 1, 0xff, 0);
    if (!Buffer.TYPED_ARRAY_SUPPORT)
      value = Math.floor(value);
    this[offset] = (value & 0xff);
    return offset + 1;
  };
  function objectWriteUInt16(buf, value, offset, littleEndian) {
    if (value < 0)
      value = 0xffff + value + 1;
    for (var i = 0,
        j = Math.min(buf.length - offset, 2); i < j; i++) {
      buf[offset + i] = (value & (0xff << (8 * (littleEndian ? i : 1 - i)))) >>> (littleEndian ? i : 1 - i) * 8;
    }
  }
  Buffer.prototype.writeUInt16LE = function writeUInt16LE(value, offset, noAssert) {
    value = +value;
    offset = offset | 0;
    if (!noAssert)
      checkInt(this, value, offset, 2, 0xffff, 0);
    if (Buffer.TYPED_ARRAY_SUPPORT) {
      this[offset] = (value & 0xff);
      this[offset + 1] = (value >>> 8);
    } else {
      objectWriteUInt16(this, value, offset, true);
    }
    return offset + 2;
  };
  Buffer.prototype.writeUInt16BE = function writeUInt16BE(value, offset, noAssert) {
    value = +value;
    offset = offset | 0;
    if (!noAssert)
      checkInt(this, value, offset, 2, 0xffff, 0);
    if (Buffer.TYPED_ARRAY_SUPPORT) {
      this[offset] = (value >>> 8);
      this[offset + 1] = (value & 0xff);
    } else {
      objectWriteUInt16(this, value, offset, false);
    }
    return offset + 2;
  };
  function objectWriteUInt32(buf, value, offset, littleEndian) {
    if (value < 0)
      value = 0xffffffff + value + 1;
    for (var i = 0,
        j = Math.min(buf.length - offset, 4); i < j; i++) {
      buf[offset + i] = (value >>> (littleEndian ? i : 3 - i) * 8) & 0xff;
    }
  }
  Buffer.prototype.writeUInt32LE = function writeUInt32LE(value, offset, noAssert) {
    value = +value;
    offset = offset | 0;
    if (!noAssert)
      checkInt(this, value, offset, 4, 0xffffffff, 0);
    if (Buffer.TYPED_ARRAY_SUPPORT) {
      this[offset + 3] = (value >>> 24);
      this[offset + 2] = (value >>> 16);
      this[offset + 1] = (value >>> 8);
      this[offset] = (value & 0xff);
    } else {
      objectWriteUInt32(this, value, offset, true);
    }
    return offset + 4;
  };
  Buffer.prototype.writeUInt32BE = function writeUInt32BE(value, offset, noAssert) {
    value = +value;
    offset = offset | 0;
    if (!noAssert)
      checkInt(this, value, offset, 4, 0xffffffff, 0);
    if (Buffer.TYPED_ARRAY_SUPPORT) {
      this[offset] = (value >>> 24);
      this[offset + 1] = (value >>> 16);
      this[offset + 2] = (value >>> 8);
      this[offset + 3] = (value & 0xff);
    } else {
      objectWriteUInt32(this, value, offset, false);
    }
    return offset + 4;
  };
  Buffer.prototype.writeIntLE = function writeIntLE(value, offset, byteLength, noAssert) {
    value = +value;
    offset = offset | 0;
    if (!noAssert) {
      var limit = Math.pow(2, 8 * byteLength - 1);
      checkInt(this, value, offset, byteLength, limit - 1, -limit);
    }
    var i = 0;
    var mul = 1;
    var sub = value < 0 ? 1 : 0;
    this[offset] = value & 0xFF;
    while (++i < byteLength && (mul *= 0x100)) {
      this[offset + i] = ((value / mul) >> 0) - sub & 0xFF;
    }
    return offset + byteLength;
  };
  Buffer.prototype.writeIntBE = function writeIntBE(value, offset, byteLength, noAssert) {
    value = +value;
    offset = offset | 0;
    if (!noAssert) {
      var limit = Math.pow(2, 8 * byteLength - 1);
      checkInt(this, value, offset, byteLength, limit - 1, -limit);
    }
    var i = byteLength - 1;
    var mul = 1;
    var sub = value < 0 ? 1 : 0;
    this[offset + i] = value & 0xFF;
    while (--i >= 0 && (mul *= 0x100)) {
      this[offset + i] = ((value / mul) >> 0) - sub & 0xFF;
    }
    return offset + byteLength;
  };
  Buffer.prototype.writeInt8 = function writeInt8(value, offset, noAssert) {
    value = +value;
    offset = offset | 0;
    if (!noAssert)
      checkInt(this, value, offset, 1, 0x7f, -0x80);
    if (!Buffer.TYPED_ARRAY_SUPPORT)
      value = Math.floor(value);
    if (value < 0)
      value = 0xff + value + 1;
    this[offset] = (value & 0xff);
    return offset + 1;
  };
  Buffer.prototype.writeInt16LE = function writeInt16LE(value, offset, noAssert) {
    value = +value;
    offset = offset | 0;
    if (!noAssert)
      checkInt(this, value, offset, 2, 0x7fff, -0x8000);
    if (Buffer.TYPED_ARRAY_SUPPORT) {
      this[offset] = (value & 0xff);
      this[offset + 1] = (value >>> 8);
    } else {
      objectWriteUInt16(this, value, offset, true);
    }
    return offset + 2;
  };
  Buffer.prototype.writeInt16BE = function writeInt16BE(value, offset, noAssert) {
    value = +value;
    offset = offset | 0;
    if (!noAssert)
      checkInt(this, value, offset, 2, 0x7fff, -0x8000);
    if (Buffer.TYPED_ARRAY_SUPPORT) {
      this[offset] = (value >>> 8);
      this[offset + 1] = (value & 0xff);
    } else {
      objectWriteUInt16(this, value, offset, false);
    }
    return offset + 2;
  };
  Buffer.prototype.writeInt32LE = function writeInt32LE(value, offset, noAssert) {
    value = +value;
    offset = offset | 0;
    if (!noAssert)
      checkInt(this, value, offset, 4, 0x7fffffff, -0x80000000);
    if (Buffer.TYPED_ARRAY_SUPPORT) {
      this[offset] = (value & 0xff);
      this[offset + 1] = (value >>> 8);
      this[offset + 2] = (value >>> 16);
      this[offset + 3] = (value >>> 24);
    } else {
      objectWriteUInt32(this, value, offset, true);
    }
    return offset + 4;
  };
  Buffer.prototype.writeInt32BE = function writeInt32BE(value, offset, noAssert) {
    value = +value;
    offset = offset | 0;
    if (!noAssert)
      checkInt(this, value, offset, 4, 0x7fffffff, -0x80000000);
    if (value < 0)
      value = 0xffffffff + value + 1;
    if (Buffer.TYPED_ARRAY_SUPPORT) {
      this[offset] = (value >>> 24);
      this[offset + 1] = (value >>> 16);
      this[offset + 2] = (value >>> 8);
      this[offset + 3] = (value & 0xff);
    } else {
      objectWriteUInt32(this, value, offset, false);
    }
    return offset + 4;
  };
  function checkIEEE754(buf, value, offset, ext, max, min) {
    if (value > max || value < min)
      throw new RangeError('value is out of bounds');
    if (offset + ext > buf.length)
      throw new RangeError('index out of range');
    if (offset < 0)
      throw new RangeError('index out of range');
  }
  function writeFloat(buf, value, offset, littleEndian, noAssert) {
    if (!noAssert) {
      checkIEEE754(buf, value, offset, 4, 3.4028234663852886e+38, -3.4028234663852886e+38);
    }
    ieee754.write(buf, value, offset, littleEndian, 23, 4);
    return offset + 4;
  }
  Buffer.prototype.writeFloatLE = function writeFloatLE(value, offset, noAssert) {
    return writeFloat(this, value, offset, true, noAssert);
  };
  Buffer.prototype.writeFloatBE = function writeFloatBE(value, offset, noAssert) {
    return writeFloat(this, value, offset, false, noAssert);
  };
  function writeDouble(buf, value, offset, littleEndian, noAssert) {
    if (!noAssert) {
      checkIEEE754(buf, value, offset, 8, 1.7976931348623157E+308, -1.7976931348623157E+308);
    }
    ieee754.write(buf, value, offset, littleEndian, 52, 8);
    return offset + 8;
  }
  Buffer.prototype.writeDoubleLE = function writeDoubleLE(value, offset, noAssert) {
    return writeDouble(this, value, offset, true, noAssert);
  };
  Buffer.prototype.writeDoubleBE = function writeDoubleBE(value, offset, noAssert) {
    return writeDouble(this, value, offset, false, noAssert);
  };
  Buffer.prototype.copy = function copy(target, targetStart, start, end) {
    if (!start)
      start = 0;
    if (!end && end !== 0)
      end = this.length;
    if (targetStart >= target.length)
      targetStart = target.length;
    if (!targetStart)
      targetStart = 0;
    if (end > 0 && end < start)
      end = start;
    if (end === start)
      return 0;
    if (target.length === 0 || this.length === 0)
      return 0;
    if (targetStart < 0) {
      throw new RangeError('targetStart out of bounds');
    }
    if (start < 0 || start >= this.length)
      throw new RangeError('sourceStart out of bounds');
    if (end < 0)
      throw new RangeError('sourceEnd out of bounds');
    if (end > this.length)
      end = this.length;
    if (target.length - targetStart < end - start) {
      end = target.length - targetStart + start;
    }
    var len = end - start;
    var i;
    if (this === target && start < targetStart && targetStart < end) {
      for (i = len - 1; i >= 0; i--) {
        target[i + targetStart] = this[i + start];
      }
    } else if (len < 1000 || !Buffer.TYPED_ARRAY_SUPPORT) {
      for (i = 0; i < len; i++) {
        target[i + targetStart] = this[i + start];
      }
    } else {
      target._set(this.subarray(start, start + len), targetStart);
    }
    return len;
  };
  Buffer.prototype.fill = function fill(value, start, end) {
    if (!value)
      value = 0;
    if (!start)
      start = 0;
    if (!end)
      end = this.length;
    if (end < start)
      throw new RangeError('end < start');
    if (end === start)
      return;
    if (this.length === 0)
      return;
    if (start < 0 || start >= this.length)
      throw new RangeError('start out of bounds');
    if (end < 0 || end > this.length)
      throw new RangeError('end out of bounds');
    var i;
    if (typeof value === 'number') {
      for (i = start; i < end; i++) {
        this[i] = value;
      }
    } else {
      var bytes = utf8ToBytes(value.toString());
      var len = bytes.length;
      for (i = start; i < end; i++) {
        this[i] = bytes[i % len];
      }
    }
    return this;
  };
  Buffer.prototype.toArrayBuffer = function toArrayBuffer() {
    if (typeof Uint8Array !== 'undefined') {
      if (Buffer.TYPED_ARRAY_SUPPORT) {
        return (new Buffer(this)).buffer;
      } else {
        var buf = new Uint8Array(this.length);
        for (var i = 0,
            len = buf.length; i < len; i += 1) {
          buf[i] = this[i];
        }
        return buf.buffer;
      }
    } else {
      throw new TypeError('Buffer.toArrayBuffer not supported in this browser');
    }
  };
  var BP = Buffer.prototype;
  Buffer._augment = function _augment(arr) {
    arr.constructor = Buffer;
    arr._isBuffer = true;
    arr._set = arr.set;
    arr.get = BP.get;
    arr.set = BP.set;
    arr.write = BP.write;
    arr.toString = BP.toString;
    arr.toLocaleString = BP.toString;
    arr.toJSON = BP.toJSON;
    arr.equals = BP.equals;
    arr.compare = BP.compare;
    arr.indexOf = BP.indexOf;
    arr.copy = BP.copy;
    arr.slice = BP.slice;
    arr.readUIntLE = BP.readUIntLE;
    arr.readUIntBE = BP.readUIntBE;
    arr.readUInt8 = BP.readUInt8;
    arr.readUInt16LE = BP.readUInt16LE;
    arr.readUInt16BE = BP.readUInt16BE;
    arr.readUInt32LE = BP.readUInt32LE;
    arr.readUInt32BE = BP.readUInt32BE;
    arr.readIntLE = BP.readIntLE;
    arr.readIntBE = BP.readIntBE;
    arr.readInt8 = BP.readInt8;
    arr.readInt16LE = BP.readInt16LE;
    arr.readInt16BE = BP.readInt16BE;
    arr.readInt32LE = BP.readInt32LE;
    arr.readInt32BE = BP.readInt32BE;
    arr.readFloatLE = BP.readFloatLE;
    arr.readFloatBE = BP.readFloatBE;
    arr.readDoubleLE = BP.readDoubleLE;
    arr.readDoubleBE = BP.readDoubleBE;
    arr.writeUInt8 = BP.writeUInt8;
    arr.writeUIntLE = BP.writeUIntLE;
    arr.writeUIntBE = BP.writeUIntBE;
    arr.writeUInt16LE = BP.writeUInt16LE;
    arr.writeUInt16BE = BP.writeUInt16BE;
    arr.writeUInt32LE = BP.writeUInt32LE;
    arr.writeUInt32BE = BP.writeUInt32BE;
    arr.writeIntLE = BP.writeIntLE;
    arr.writeIntBE = BP.writeIntBE;
    arr.writeInt8 = BP.writeInt8;
    arr.writeInt16LE = BP.writeInt16LE;
    arr.writeInt16BE = BP.writeInt16BE;
    arr.writeInt32LE = BP.writeInt32LE;
    arr.writeInt32BE = BP.writeInt32BE;
    arr.writeFloatLE = BP.writeFloatLE;
    arr.writeFloatBE = BP.writeFloatBE;
    arr.writeDoubleLE = BP.writeDoubleLE;
    arr.writeDoubleBE = BP.writeDoubleBE;
    arr.fill = BP.fill;
    arr.inspect = BP.inspect;
    arr.toArrayBuffer = BP.toArrayBuffer;
    return arr;
  };
  var INVALID_BASE64_RE = /[^+\/0-9A-Za-z-_]/g;
  function base64clean(str) {
    str = stringtrim(str).replace(INVALID_BASE64_RE, '');
    if (str.length < 2)
      return '';
    while (str.length % 4 !== 0) {
      str = str + '=';
    }
    return str;
  }
  function stringtrim(str) {
    if (str.trim)
      return str.trim();
    return str.replace(/^\s+|\s+$/g, '');
  }
  function toHex(n) {
    if (n < 16)
      return '0' + n.toString(16);
    return n.toString(16);
  }
  function utf8ToBytes(string, units) {
    units = units || Infinity;
    var codePoint;
    var length = string.length;
    var leadSurrogate = null;
    var bytes = [];
    for (var i = 0; i < length; i++) {
      codePoint = string.charCodeAt(i);
      if (codePoint > 0xD7FF && codePoint < 0xE000) {
        if (!leadSurrogate) {
          if (codePoint > 0xDBFF) {
            if ((units -= 3) > -1)
              bytes.push(0xEF, 0xBF, 0xBD);
            continue;
          } else if (i + 1 === length) {
            if ((units -= 3) > -1)
              bytes.push(0xEF, 0xBF, 0xBD);
            continue;
          }
          leadSurrogate = codePoint;
          continue;
        }
        if (codePoint < 0xDC00) {
          if ((units -= 3) > -1)
            bytes.push(0xEF, 0xBF, 0xBD);
          leadSurrogate = codePoint;
          continue;
        }
        codePoint = leadSurrogate - 0xD800 << 10 | codePoint - 0xDC00 | 0x10000;
      } else if (leadSurrogate) {
        if ((units -= 3) > -1)
          bytes.push(0xEF, 0xBF, 0xBD);
      }
      leadSurrogate = null;
      if (codePoint < 0x80) {
        if ((units -= 1) < 0)
          break;
        bytes.push(codePoint);
      } else if (codePoint < 0x800) {
        if ((units -= 2) < 0)
          break;
        bytes.push(codePoint >> 0x6 | 0xC0, codePoint & 0x3F | 0x80);
      } else if (codePoint < 0x10000) {
        if ((units -= 3) < 0)
          break;
        bytes.push(codePoint >> 0xC | 0xE0, codePoint >> 0x6 & 0x3F | 0x80, codePoint & 0x3F | 0x80);
      } else if (codePoint < 0x110000) {
        if ((units -= 4) < 0)
          break;
        bytes.push(codePoint >> 0x12 | 0xF0, codePoint >> 0xC & 0x3F | 0x80, codePoint >> 0x6 & 0x3F | 0x80, codePoint & 0x3F | 0x80);
      } else {
        throw new Error('Invalid code point');
      }
    }
    return bytes;
  }
  function asciiToBytes(str) {
    var byteArray = [];
    for (var i = 0; i < str.length; i++) {
      byteArray.push(str.charCodeAt(i) & 0xFF);
    }
    return byteArray;
  }
  function utf16leToBytes(str, units) {
    var c,
        hi,
        lo;
    var byteArray = [];
    for (var i = 0; i < str.length; i++) {
      if ((units -= 2) < 0)
        break;
      c = str.charCodeAt(i);
      hi = c >> 8;
      lo = c % 256;
      byteArray.push(lo);
      byteArray.push(hi);
    }
    return byteArray;
  }
  function base64ToBytes(str) {
    return base64.toByteArray(base64clean(str));
  }
  function blitBuffer(src, dst, offset, length) {
    for (var i = 0; i < length; i++) {
      if ((i + offset >= dst.length) || (i >= src.length))
        break;
      dst[i + offset] = src[i];
    }
    return i;
  }
  global.define = __define;
  return module.exports;
});

$__System.registerDynamic("2d", ["2c"], true, function(require, exports, module) {
  ;
  var global = this,
      __define = global.define;
  global.define = undefined;
  module.exports = require("2c");
  global.define = __define;
  return module.exports;
});

$__System.registerDynamic("2e", ["2d"], true, function(require, exports, module) {
  ;
  var global = this,
      __define = global.define;
  global.define = undefined;
  module.exports = $__System._nodeRequire ? $__System._nodeRequire('buffer') : require("2d");
  global.define = __define;
  return module.exports;
});

$__System.registerDynamic("2f", ["2e"], true, function(require, exports, module) {
  ;
  var global = this,
      __define = global.define;
  global.define = undefined;
  module.exports = require("2e");
  global.define = __define;
  return module.exports;
});

$__System.registerDynamic("30", ["2f"], true, function(require, exports, module) {
  ;
  var global = this,
      __define = global.define;
  global.define = undefined;
  "format cjs";
  (function(Buffer) {
    (function() {
      var _global = this;
      var _rng;
      if (typeof(_global.require) == 'function') {
        try {
          var _rb = _global.require('crypto').randomBytes;
          _rng = _rb && function() {
            return _rb(16);
          };
        } catch (e) {}
      }
      if (!_rng && _global.crypto && crypto.getRandomValues) {
        var _rnds8 = new Uint8Array(16);
        _rng = function whatwgRNG() {
          crypto.getRandomValues(_rnds8);
          return _rnds8;
        };
      }
      if (!_rng) {
        var _rnds = new Array(16);
        _rng = function() {
          for (var i = 0,
              r; i < 16; i++) {
            if ((i & 0x03) === 0)
              r = Math.random() * 0x100000000;
            _rnds[i] = r >>> ((i & 0x03) << 3) & 0xff;
          }
          return _rnds;
        };
      }
      var BufferClass = typeof(_global.Buffer) == 'function' ? _global.Buffer : Array;
      var _byteToHex = [];
      var _hexToByte = {};
      for (var i = 0; i < 256; i++) {
        _byteToHex[i] = (i + 0x100).toString(16).substr(1);
        _hexToByte[_byteToHex[i]] = i;
      }
      function parse(s, buf, offset) {
        var i = (buf && offset) || 0,
            ii = 0;
        buf = buf || [];
        s.toLowerCase().replace(/[0-9a-f]{2}/g, function(oct) {
          if (ii < 16) {
            buf[i + ii++] = _hexToByte[oct];
          }
        });
        while (ii < 16) {
          buf[i + ii++] = 0;
        }
        return buf;
      }
      function unparse(buf, offset) {
        var i = offset || 0,
            bth = _byteToHex;
        return bth[buf[i++]] + bth[buf[i++]] + bth[buf[i++]] + bth[buf[i++]] + '-' + bth[buf[i++]] + bth[buf[i++]] + '-' + bth[buf[i++]] + bth[buf[i++]] + '-' + bth[buf[i++]] + bth[buf[i++]] + '-' + bth[buf[i++]] + bth[buf[i++]] + bth[buf[i++]] + bth[buf[i++]] + bth[buf[i++]] + bth[buf[i++]];
      }
      var _seedBytes = _rng();
      var _nodeId = [_seedBytes[0] | 0x01, _seedBytes[1], _seedBytes[2], _seedBytes[3], _seedBytes[4], _seedBytes[5]];
      var _clockseq = (_seedBytes[6] << 8 | _seedBytes[7]) & 0x3fff;
      var _lastMSecs = 0,
          _lastNSecs = 0;
      function v1(options, buf, offset) {
        var i = buf && offset || 0;
        var b = buf || [];
        options = options || {};
        var clockseq = options.clockseq != null ? options.clockseq : _clockseq;
        var msecs = options.msecs != null ? options.msecs : new Date().getTime();
        var nsecs = options.nsecs != null ? options.nsecs : _lastNSecs + 1;
        var dt = (msecs - _lastMSecs) + (nsecs - _lastNSecs) / 10000;
        if (dt < 0 && options.clockseq == null) {
          clockseq = clockseq + 1 & 0x3fff;
        }
        if ((dt < 0 || msecs > _lastMSecs) && options.nsecs == null) {
          nsecs = 0;
        }
        if (nsecs >= 10000) {
          throw new Error('uuid.v1(): Can\'t create more than 10M uuids/sec');
        }
        _lastMSecs = msecs;
        _lastNSecs = nsecs;
        _clockseq = clockseq;
        msecs += 12219292800000;
        var tl = ((msecs & 0xfffffff) * 10000 + nsecs) % 0x100000000;
        b[i++] = tl >>> 24 & 0xff;
        b[i++] = tl >>> 16 & 0xff;
        b[i++] = tl >>> 8 & 0xff;
        b[i++] = tl & 0xff;
        var tmh = (msecs / 0x100000000 * 10000) & 0xfffffff;
        b[i++] = tmh >>> 8 & 0xff;
        b[i++] = tmh & 0xff;
        b[i++] = tmh >>> 24 & 0xf | 0x10;
        b[i++] = tmh >>> 16 & 0xff;
        b[i++] = clockseq >>> 8 | 0x80;
        b[i++] = clockseq & 0xff;
        var node = options.node || _nodeId;
        for (var n = 0; n < 6; n++) {
          b[i + n] = node[n];
        }
        return buf ? buf : unparse(b);
      }
      function v4(options, buf, offset) {
        var i = buf && offset || 0;
        if (typeof(options) == 'string') {
          buf = options == 'binary' ? new BufferClass(16) : null;
          options = null;
        }
        options = options || {};
        var rnds = options.random || (options.rng || _rng)();
        rnds[6] = (rnds[6] & 0x0f) | 0x40;
        rnds[8] = (rnds[8] & 0x3f) | 0x80;
        if (buf) {
          for (var ii = 0; ii < 16; ii++) {
            buf[i + ii] = rnds[ii];
          }
        }
        return buf || unparse(rnds);
      }
      var uuid = v4;
      uuid.v1 = v1;
      uuid.v4 = v4;
      uuid.parse = parse;
      uuid.unparse = unparse;
      uuid.BufferClass = BufferClass;
      if (typeof(module) != 'undefined' && module.exports) {
        module.exports = uuid;
      } else if (typeof define === 'function' && define.amd) {
        define(function() {
          return uuid;
        });
      } else {
        var _previousRoot = _global.uuid;
        uuid.noConflict = function() {
          _global.uuid = _previousRoot;
          return uuid;
        };
        _global.uuid = uuid;
      }
    }).call(this);
  })(require("2f").Buffer);
  global.define = __define;
  return module.exports;
});

$__System.registerDynamic("31", ["30"], true, function(require, exports, module) {
  ;
  var global = this,
      __define = global.define;
  global.define = undefined;
  module.exports = require("30");
  global.define = __define;
  return module.exports;
});

$__System.registerDynamic("33", [], true, function(require, exports, module) {
  ;
  var global = this,
      __define = global.define;
  global.define = undefined;
  module.exports = function() {};
  global.define = __define;
  return module.exports;
});

$__System.registerDynamic("34", [], true, function(require, exports, module) {
  ;
  var global = this,
      __define = global.define;
  global.define = undefined;
  module.exports = function(done, value) {
    return {
      value: value,
      done: !!done
    };
  };
  global.define = __define;
  return module.exports;
});

$__System.registerDynamic("35", [], true, function(require, exports, module) {
  ;
  var global = this,
      __define = global.define;
  global.define = undefined;
  module.exports = {};
  global.define = __define;
  return module.exports;
});

$__System.registerDynamic("36", ["2", "9", "f", "a", "e"], true, function(require, exports, module) {
  ;
  var global = this,
      __define = global.define;
  global.define = undefined;
  'use strict';
  var $ = require("2"),
      descriptor = require("9"),
      setToStringTag = require("f"),
      IteratorPrototype = {};
  require("a")(IteratorPrototype, require("e")('iterator'), function() {
    return this;
  });
  module.exports = function(Constructor, NAME, next) {
    Constructor.prototype = $.create(IteratorPrototype, {next: descriptor(1, next)});
    setToStringTag(Constructor, NAME + ' Iterator');
  };
  global.define = __define;
  return module.exports;
});

$__System.registerDynamic("37", ["1a", "8", "b", "a", "4", "e", "35", "36", "f", "2"], true, function(require, exports, module) {
  ;
  var global = this,
      __define = global.define;
  global.define = undefined;
  'use strict';
  var LIBRARY = require("1a"),
      $def = require("8"),
      $redef = require("b"),
      hide = require("a"),
      has = require("4"),
      SYMBOL_ITERATOR = require("e")('iterator'),
      Iterators = require("35"),
      $iterCreate = require("36"),
      setToStringTag = require("f"),
      getProto = require("2").getProto,
      BUGGY = !([].keys && 'next' in [].keys()),
      FF_ITERATOR = '@@iterator',
      KEYS = 'keys',
      VALUES = 'values';
  var returnThis = function() {
    return this;
  };
  module.exports = function(Base, NAME, Constructor, next, DEFAULT, IS_SET, FORCE) {
    $iterCreate(Constructor, NAME, next);
    var getMethod = function(kind) {
      if (!BUGGY && kind in proto)
        return proto[kind];
      switch (kind) {
        case KEYS:
          return function keys() {
            return new Constructor(this, kind);
          };
        case VALUES:
          return function values() {
            return new Constructor(this, kind);
          };
      }
      return function entries() {
        return new Constructor(this, kind);
      };
    };
    var TAG = NAME + ' Iterator',
        proto = Base.prototype,
        _native = proto[SYMBOL_ITERATOR] || proto[FF_ITERATOR] || DEFAULT && proto[DEFAULT],
        _default = _native || getMethod(DEFAULT),
        methods,
        key;
    if (_native) {
      var IteratorPrototype = getProto(_default.call(new Base));
      setToStringTag(IteratorPrototype, TAG, true);
      if (!LIBRARY && has(proto, FF_ITERATOR))
        hide(IteratorPrototype, SYMBOL_ITERATOR, returnThis);
    }
    if ((!LIBRARY || FORCE) && (BUGGY || !(SYMBOL_ITERATOR in proto))) {
      hide(proto, SYMBOL_ITERATOR, _default);
    }
    Iterators[NAME] = _default;
    Iterators[TAG] = returnThis;
    if (DEFAULT) {
      methods = {
        values: DEFAULT == VALUES ? _default : getMethod(VALUES),
        keys: IS_SET ? _default : getMethod(KEYS),
        entries: DEFAULT != VALUES ? _default : getMethod('entries')
      };
      if (FORCE)
        for (key in methods) {
          if (!(key in proto))
            $redef(proto, key, methods[key]);
        }
      else
        $def($def.P + $def.F * BUGGY, NAME, methods);
    }
    return methods;
  };
  global.define = __define;
  return module.exports;
});

$__System.registerDynamic("38", ["33", "34", "35", "13", "37"], true, function(require, exports, module) {
  ;
  var global = this,
      __define = global.define;
  global.define = undefined;
  'use strict';
  var addToUnscopables = require("33"),
      step = require("34"),
      Iterators = require("35"),
      toIObject = require("13");
  module.exports = require("37")(Array, 'Array', function(iterated, kind) {
    this._t = toIObject(iterated);
    this._i = 0;
    this._k = kind;
  }, function() {
    var O = this._t,
        kind = this._k,
        index = this._i++;
    if (!O || index >= O.length) {
      this._t = undefined;
      return step(1);
    }
    if (kind == 'keys')
      return step(0, index);
    if (kind == 'values')
      return step(0, O[index]);
    return step(0, [index, O[index]]);
  }, 'values');
  Iterators.Arguments = Iterators.Array;
  addToUnscopables('keys');
  addToUnscopables('values');
  addToUnscopables('entries');
  global.define = __define;
  return module.exports;
});

$__System.registerDynamic("39", ["38", "35"], true, function(require, exports, module) {
  ;
  var global = this,
      __define = global.define;
  global.define = undefined;
  require("38");
  var Iterators = require("35");
  Iterators.NodeList = Iterators.HTMLCollection = Iterators.Array;
  global.define = __define;
  return module.exports;
});

$__System.registerDynamic("3a", ["b"], true, function(require, exports, module) {
  ;
  var global = this,
      __define = global.define;
  global.define = undefined;
  var $redef = require("b");
  module.exports = function(target, src) {
    for (var key in src)
      $redef(target, key, src[key]);
    return target;
  };
  global.define = __define;
  return module.exports;
});

$__System.registerDynamic("3b", [], true, function(require, exports, module) {
  ;
  var global = this,
      __define = global.define;
  global.define = undefined;
  module.exports = function(it, Constructor, name) {
    if (!(it instanceof Constructor))
      throw TypeError(name + ": use the 'new' operator!");
    return it;
  };
  global.define = __define;
  return module.exports;
});

$__System.registerDynamic("3c", [], true, function(require, exports, module) {
  ;
  var global = this,
      __define = global.define;
  global.define = undefined;
  module.exports = function(it) {
    if (typeof it != 'function')
      throw TypeError(it + ' is not a function!');
    return it;
  };
  global.define = __define;
  return module.exports;
});

$__System.registerDynamic("3d", ["3c"], true, function(require, exports, module) {
  ;
  var global = this,
      __define = global.define;
  global.define = undefined;
  var aFunction = require("3c");
  module.exports = function(fn, that, length) {
    aFunction(fn);
    if (that === undefined)
      return fn;
    switch (length) {
      case 1:
        return function(a) {
          return fn.call(that, a);
        };
      case 2:
        return function(a, b) {
          return fn.call(that, a, b);
        };
      case 3:
        return function(a, b, c) {
          return fn.call(that, a, b, c);
        };
    }
    return function() {
      return fn.apply(that, arguments);
    };
  };
  global.define = __define;
  return module.exports;
});

$__System.registerDynamic("3e", ["19"], true, function(require, exports, module) {
  ;
  var global = this,
      __define = global.define;
  global.define = undefined;
  var anObject = require("19");
  module.exports = function(iterator, fn, value, entries) {
    try {
      return entries ? fn(anObject(value)[0], value[1]) : fn(value);
    } catch (e) {
      var ret = iterator['return'];
      if (ret !== undefined)
        anObject(ret.call(iterator));
      throw e;
    }
  };
  global.define = __define;
  return module.exports;
});

$__System.registerDynamic("3f", ["35", "e"], true, function(require, exports, module) {
  ;
  var global = this,
      __define = global.define;
  global.define = undefined;
  var Iterators = require("35"),
      ITERATOR = require("e")('iterator'),
      ArrayProto = Array.prototype;
  module.exports = function(it) {
    return (Iterators.Array || ArrayProto[ITERATOR]) === it;
  };
  global.define = __define;
  return module.exports;
});

$__System.registerDynamic("40", [], true, function(require, exports, module) {
  ;
  var global = this,
      __define = global.define;
  global.define = undefined;
  var ceil = Math.ceil,
      floor = Math.floor;
  module.exports = function(it) {
    return isNaN(it = +it) ? 0 : (it > 0 ? floor : ceil)(it);
  };
  global.define = __define;
  return module.exports;
});

$__System.registerDynamic("41", ["40"], true, function(require, exports, module) {
  ;
  var global = this,
      __define = global.define;
  global.define = undefined;
  var toInteger = require("40"),
      min = Math.min;
  module.exports = function(it) {
    return it > 0 ? min(toInteger(it), 0x1fffffffffffff) : 0;
  };
  global.define = __define;
  return module.exports;
});

$__System.registerDynamic("42", ["10", "e"], true, function(require, exports, module) {
  ;
  var global = this,
      __define = global.define;
  global.define = undefined;
  var cof = require("10"),
      TAG = require("e")('toStringTag'),
      ARG = cof(function() {
        return arguments;
      }()) == 'Arguments';
  module.exports = function(it) {
    var O,
        T,
        B;
    return it === undefined ? 'Undefined' : it === null ? 'Null' : typeof(T = (O = Object(it))[TAG]) == 'string' ? T : ARG ? cof(O) : (B = cof(O)) == 'Object' && typeof O.callee == 'function' ? 'Arguments' : B;
  };
  global.define = __define;
  return module.exports;
});

$__System.registerDynamic("43", ["42", "e", "35", "7"], true, function(require, exports, module) {
  ;
  var global = this,
      __define = global.define;
  global.define = undefined;
  var classof = require("42"),
      ITERATOR = require("e")('iterator'),
      Iterators = require("35");
  module.exports = require("7").getIteratorMethod = function(it) {
    if (it != undefined)
      return it[ITERATOR] || it['@@iterator'] || Iterators[classof(it)];
  };
  global.define = __define;
  return module.exports;
});

$__System.registerDynamic("44", ["3d", "3e", "3f", "19", "41", "43"], true, function(require, exports, module) {
  ;
  var global = this,
      __define = global.define;
  global.define = undefined;
  var ctx = require("3d"),
      call = require("3e"),
      isArrayIter = require("3f"),
      anObject = require("19"),
      toLength = require("41"),
      getIterFn = require("43");
  module.exports = function(iterable, entries, fn, that) {
    var iterFn = getIterFn(iterable),
        f = ctx(fn, that, entries ? 2 : 1),
        index = 0,
        length,
        step,
        iterator;
    if (typeof iterFn != 'function')
      throw TypeError(iterable + ' is not iterable!');
    if (isArrayIter(iterFn))
      for (length = toLength(iterable.length); length > index; index++) {
        entries ? f(anObject(step = iterable[index])[0], step[1]) : f(iterable[index]);
      }
    else
      for (iterator = iterFn.call(iterable); !(step = iterator.next()).done; ) {
        call(iterator, f, step.value, entries);
      }
  };
  global.define = __define;
  return module.exports;
});

$__System.registerDynamic("45", ["12"], true, function(require, exports, module) {
  ;
  var global = this,
      __define = global.define;
  global.define = undefined;
  var defined = require("12");
  module.exports = function(it) {
    return Object(defined(it));
  };
  global.define = __define;
  return module.exports;
});

$__System.registerDynamic("46", ["18", "17", "e"], true, function(require, exports, module) {
  ;
  var global = this,
      __define = global.define;
  global.define = undefined;
  var isObject = require("18"),
      isArray = require("17"),
      SPECIES = require("e")('species');
  module.exports = function(original, length) {
    var C;
    if (isArray(original)) {
      C = original.constructor;
      if (typeof C == 'function' && (C === Array || isArray(C.prototype)))
        C = undefined;
      if (isObject(C)) {
        C = C[SPECIES];
        if (C === null)
          C = undefined;
      }
    }
    return new (C === undefined ? Array : C)(length);
  };
  global.define = __define;
  return module.exports;
});

$__System.registerDynamic("47", ["3d", "11", "45", "41", "46"], true, function(require, exports, module) {
  ;
  var global = this,
      __define = global.define;
  global.define = undefined;
  var ctx = require("3d"),
      IObject = require("11"),
      toObject = require("45"),
      toLength = require("41"),
      asc = require("46");
  module.exports = function(TYPE) {
    var IS_MAP = TYPE == 1,
        IS_FILTER = TYPE == 2,
        IS_SOME = TYPE == 3,
        IS_EVERY = TYPE == 4,
        IS_FIND_INDEX = TYPE == 6,
        NO_HOLES = TYPE == 5 || IS_FIND_INDEX;
    return function($this, callbackfn, that) {
      var O = toObject($this),
          self = IObject(O),
          f = ctx(callbackfn, that, 3),
          length = toLength(self.length),
          index = 0,
          result = IS_MAP ? asc($this, length) : IS_FILTER ? asc($this, 0) : undefined,
          val,
          res;
      for (; length > index; index++)
        if (NO_HOLES || index in self) {
          val = self[index];
          res = f(val, index, O);
          if (TYPE) {
            if (IS_MAP)
              result[index] = res;
            else if (res)
              switch (TYPE) {
                case 3:
                  return true;
                case 5:
                  return val;
                case 6:
                  return index;
                case 2:
                  result.push(val);
              }
            else if (IS_EVERY)
              return false;
          }
        }
      return IS_FIND_INDEX ? -1 : IS_SOME || IS_EVERY ? IS_EVERY : result;
    };
  };
  global.define = __define;
  return module.exports;
});

$__System.registerDynamic("48", ["a", "3a", "19", "3b", "44", "47", "d", "18", "4"], true, function(require, exports, module) {
  ;
  var global = this,
      __define = global.define;
  global.define = undefined;
  'use strict';
  var hide = require("a"),
      mix = require("3a"),
      anObject = require("19"),
      strictNew = require("3b"),
      forOf = require("44"),
      method = require("47"),
      WEAK = require("d")('weak'),
      isObject = require("18"),
      $has = require("4"),
      isExtensible = Object.isExtensible || isObject,
      find = method(5),
      findIndex = method(6),
      id = 0;
  var frozenStore = function(that) {
    return that._l || (that._l = new FrozenStore);
  };
  var FrozenStore = function() {
    this.a = [];
  };
  var findFrozen = function(store, key) {
    return find(store.a, function(it) {
      return it[0] === key;
    });
  };
  FrozenStore.prototype = {
    get: function(key) {
      var entry = findFrozen(this, key);
      if (entry)
        return entry[1];
    },
    has: function(key) {
      return !!findFrozen(this, key);
    },
    set: function(key, value) {
      var entry = findFrozen(this, key);
      if (entry)
        entry[1] = value;
      else
        this.a.push([key, value]);
    },
    'delete': function(key) {
      var index = findIndex(this.a, function(it) {
        return it[0] === key;
      });
      if (~index)
        this.a.splice(index, 1);
      return !!~index;
    }
  };
  module.exports = {
    getConstructor: function(wrapper, NAME, IS_MAP, ADDER) {
      var C = wrapper(function(that, iterable) {
        strictNew(that, C, NAME);
        that._i = id++;
        that._l = undefined;
        if (iterable != undefined)
          forOf(iterable, IS_MAP, that[ADDER], that);
      });
      mix(C.prototype, {
        'delete': function(key) {
          if (!isObject(key))
            return false;
          if (!isExtensible(key))
            return frozenStore(this)['delete'](key);
          return $has(key, WEAK) && $has(key[WEAK], this._i) && delete key[WEAK][this._i];
        },
        has: function has(key) {
          if (!isObject(key))
            return false;
          if (!isExtensible(key))
            return frozenStore(this).has(key);
          return $has(key, WEAK) && $has(key[WEAK], this._i);
        }
      });
      return C;
    },
    def: function(that, key, value) {
      if (!isExtensible(anObject(key))) {
        frozenStore(that).set(key, value);
      } else {
        $has(key, WEAK) || hide(key, WEAK, {});
        key[WEAK][that._i] = value;
      }
      return that;
    },
    frozenStore: frozenStore,
    WEAK: WEAK
  };
  global.define = __define;
  return module.exports;
});

$__System.registerDynamic("49", ["3", "2", "8", "5", "a", "3a", "44", "3b", "18", "6", "f"], true, function(require, exports, module) {
  ;
  var global = this,
      __define = global.define;
  global.define = undefined;
  'use strict';
  var global = require("3"),
      $ = require("2"),
      $def = require("8"),
      fails = require("5"),
      hide = require("a"),
      mix = require("3a"),
      forOf = require("44"),
      strictNew = require("3b"),
      isObject = require("18"),
      DESCRIPTORS = require("6"),
      setToStringTag = require("f");
  module.exports = function(NAME, wrapper, methods, common, IS_MAP, IS_WEAK) {
    var Base = global[NAME],
        C = Base,
        ADDER = IS_MAP ? 'set' : 'add',
        proto = C && C.prototype,
        O = {};
    if (!DESCRIPTORS || typeof C != 'function' || !(IS_WEAK || proto.forEach && !fails(function() {
      new C().entries().next();
    }))) {
      C = common.getConstructor(wrapper, NAME, IS_MAP, ADDER);
      mix(C.prototype, methods);
    } else {
      C = wrapper(function(target, iterable) {
        strictNew(target, C, NAME);
        target._c = new Base;
        if (iterable != undefined)
          forOf(iterable, IS_MAP, target[ADDER], target);
      });
      $.each.call('add,clear,delete,forEach,get,has,set,keys,values,entries'.split(','), function(KEY) {
        var IS_ADDER = KEY == 'add' || KEY == 'set';
        if (KEY in proto && !(IS_WEAK && KEY == 'clear'))
          hide(C.prototype, KEY, function(a, b) {
            if (!IS_ADDER && IS_WEAK && !isObject(a))
              return KEY == 'get' ? undefined : false;
            var result = this._c[KEY](a === 0 ? 0 : a, b);
            return IS_ADDER ? this : result;
          });
      });
      if ('size' in proto)
        $.setDesc(C.prototype, 'size', {get: function() {
            return this._c.size;
          }});
    }
    setToStringTag(C, NAME);
    O[NAME] = C;
    $def($def.G + $def.W + $def.F, O);
    if (!IS_WEAK)
      common.setStrong(C, NAME, IS_MAP);
    return C;
  };
  global.define = __define;
  return module.exports;
});

$__System.registerDynamic("4a", ["2", "b", "48", "18", "4", "49"], true, function(require, exports, module) {
  ;
  var global = this,
      __define = global.define;
  global.define = undefined;
  'use strict';
  var $ = require("2"),
      redef = require("b"),
      weak = require("48"),
      isObject = require("18"),
      has = require("4"),
      frozenStore = weak.frozenStore,
      WEAK = weak.WEAK,
      isExtensible = Object.isExtensible || isObject,
      tmp = {};
  var $WeakMap = require("49")('WeakMap', function(get) {
    return function WeakMap() {
      return get(this, arguments.length > 0 ? arguments[0] : undefined);
    };
  }, {
    get: function get(key) {
      if (isObject(key)) {
        if (!isExtensible(key))
          return frozenStore(this).get(key);
        if (has(key, WEAK))
          return key[WEAK][this._i];
      }
    },
    set: function set(key, value) {
      return weak.def(this, key, value);
    }
  }, weak, true, true);
  if (new $WeakMap().set((Object.freeze || Object)(tmp), 7).get(tmp) != 7) {
    $.each.call(['delete', 'has', 'get', 'set'], function(key) {
      var proto = $WeakMap.prototype,
          method = proto[key];
      redef(proto, key, function(a, b) {
        if (isObject(a) && !isExtensible(a)) {
          var result = frozenStore(this)[key](a, b);
          return key == 'set' ? this : result;
        }
        return method.call(this, a, b);
      });
    });
  }
  global.define = __define;
  return module.exports;
});

$__System.registerDynamic("4b", ["1c", "39", "4a", "7"], true, function(require, exports, module) {
  ;
  var global = this,
      __define = global.define;
  global.define = undefined;
  require("1c");
  require("39");
  require("4a");
  module.exports = require("7").WeakMap;
  global.define = __define;
  return module.exports;
});

$__System.registerDynamic("4c", ["4b"], true, function(require, exports, module) {
  ;
  var global = this,
      __define = global.define;
  global.define = undefined;
  module.exports = {
    "default": require("4b"),
    __esModule: true
  };
  global.define = __define;
  return module.exports;
});

$__System.registerDynamic("4d", ["40", "12"], true, function(require, exports, module) {
  ;
  var global = this,
      __define = global.define;
  global.define = undefined;
  var toInteger = require("40"),
      defined = require("12");
  module.exports = function(TO_STRING) {
    return function(that, pos) {
      var s = String(defined(that)),
          i = toInteger(pos),
          l = s.length,
          a,
          b;
      if (i < 0 || i >= l)
        return TO_STRING ? '' : undefined;
      a = s.charCodeAt(i);
      return a < 0xd800 || a > 0xdbff || i + 1 === l || (b = s.charCodeAt(i + 1)) < 0xdc00 || b > 0xdfff ? TO_STRING ? s.charAt(i) : a : TO_STRING ? s.slice(i, i + 2) : (a - 0xd800 << 10) + (b - 0xdc00) + 0x10000;
    };
  };
  global.define = __define;
  return module.exports;
});

$__System.registerDynamic("4e", ["4d", "37"], true, function(require, exports, module) {
  ;
  var global = this,
      __define = global.define;
  global.define = undefined;
  'use strict';
  var $at = require("4d")(true);
  require("37")(String, 'String', function(iterated) {
    this._t = String(iterated);
    this._i = 0;
  }, function() {
    var O = this._t,
        index = this._i,
        point;
    if (index >= O.length)
      return {
        value: undefined,
        done: true
      };
    point = $at(O, index);
    this._i += point.length;
    return {
      value: point,
      done: false
    };
  });
  global.define = __define;
  return module.exports;
});

$__System.registerDynamic("4f", ["7", "2", "6", "e"], true, function(require, exports, module) {
  ;
  var global = this,
      __define = global.define;
  global.define = undefined;
  'use strict';
  var core = require("7"),
      $ = require("2"),
      DESCRIPTORS = require("6"),
      SPECIES = require("e")('species');
  module.exports = function(KEY) {
    var C = core[KEY];
    if (DESCRIPTORS && C && !C[SPECIES])
      $.setDesc(C, SPECIES, {
        configurable: true,
        get: function() {
          return this;
        }
      });
  };
  global.define = __define;
  return module.exports;
});

$__System.registerDynamic("50", ["2", "a", "3a", "3d", "3b", "12", "44", "37", "34", "d", "4", "18", "4f", "6"], true, function(require, exports, module) {
  ;
  var global = this,
      __define = global.define;
  global.define = undefined;
  'use strict';
  var $ = require("2"),
      hide = require("a"),
      mix = require("3a"),
      ctx = require("3d"),
      strictNew = require("3b"),
      defined = require("12"),
      forOf = require("44"),
      $iterDefine = require("37"),
      step = require("34"),
      ID = require("d")('id'),
      $has = require("4"),
      isObject = require("18"),
      setSpecies = require("4f"),
      DESCRIPTORS = require("6"),
      isExtensible = Object.isExtensible || isObject,
      SIZE = DESCRIPTORS ? '_s' : 'size',
      id = 0;
  var fastKey = function(it, create) {
    if (!isObject(it))
      return typeof it == 'symbol' ? it : (typeof it == 'string' ? 'S' : 'P') + it;
    if (!$has(it, ID)) {
      if (!isExtensible(it))
        return 'F';
      if (!create)
        return 'E';
      hide(it, ID, ++id);
    }
    return 'O' + it[ID];
  };
  var getEntry = function(that, key) {
    var index = fastKey(key),
        entry;
    if (index !== 'F')
      return that._i[index];
    for (entry = that._f; entry; entry = entry.n) {
      if (entry.k == key)
        return entry;
    }
  };
  module.exports = {
    getConstructor: function(wrapper, NAME, IS_MAP, ADDER) {
      var C = wrapper(function(that, iterable) {
        strictNew(that, C, NAME);
        that._i = $.create(null);
        that._f = undefined;
        that._l = undefined;
        that[SIZE] = 0;
        if (iterable != undefined)
          forOf(iterable, IS_MAP, that[ADDER], that);
      });
      mix(C.prototype, {
        clear: function clear() {
          for (var that = this,
              data = that._i,
              entry = that._f; entry; entry = entry.n) {
            entry.r = true;
            if (entry.p)
              entry.p = entry.p.n = undefined;
            delete data[entry.i];
          }
          that._f = that._l = undefined;
          that[SIZE] = 0;
        },
        'delete': function(key) {
          var that = this,
              entry = getEntry(that, key);
          if (entry) {
            var next = entry.n,
                prev = entry.p;
            delete that._i[entry.i];
            entry.r = true;
            if (prev)
              prev.n = next;
            if (next)
              next.p = prev;
            if (that._f == entry)
              that._f = next;
            if (that._l == entry)
              that._l = prev;
            that[SIZE]--;
          }
          return !!entry;
        },
        forEach: function forEach(callbackfn) {
          var f = ctx(callbackfn, arguments.length > 1 ? arguments[1] : undefined, 3),
              entry;
          while (entry = entry ? entry.n : this._f) {
            f(entry.v, entry.k, this);
            while (entry && entry.r)
              entry = entry.p;
          }
        },
        has: function has(key) {
          return !!getEntry(this, key);
        }
      });
      if (DESCRIPTORS)
        $.setDesc(C.prototype, 'size', {get: function() {
            return defined(this[SIZE]);
          }});
      return C;
    },
    def: function(that, key, value) {
      var entry = getEntry(that, key),
          prev,
          index;
      if (entry) {
        entry.v = value;
      } else {
        that._l = entry = {
          i: index = fastKey(key, true),
          k: key,
          v: value,
          p: prev = that._l,
          n: undefined,
          r: false
        };
        if (!that._f)
          that._f = entry;
        if (prev)
          prev.n = entry;
        that[SIZE]++;
        if (index !== 'F')
          that._i[index] = entry;
      }
      return that;
    },
    getEntry: getEntry,
    setStrong: function(C, NAME, IS_MAP) {
      $iterDefine(C, NAME, function(iterated, kind) {
        this._t = iterated;
        this._k = kind;
        this._l = undefined;
      }, function() {
        var that = this,
            kind = that._k,
            entry = that._l;
        while (entry && entry.r)
          entry = entry.p;
        if (!that._t || !(that._l = entry = entry ? entry.n : that._t._f)) {
          that._t = undefined;
          return step(1);
        }
        if (kind == 'keys')
          return step(0, entry.k);
        if (kind == 'values')
          return step(0, entry.v);
        return step(0, [entry.k, entry.v]);
      }, IS_MAP ? 'entries' : 'values', !IS_MAP, true);
      setSpecies(NAME);
    }
  };
  global.define = __define;
  return module.exports;
});

$__System.registerDynamic("51", ["50", "49"], true, function(require, exports, module) {
  ;
  var global = this,
      __define = global.define;
  global.define = undefined;
  'use strict';
  var strong = require("50");
  require("49")('Map', function(get) {
    return function Map() {
      return get(this, arguments.length > 0 ? arguments[0] : undefined);
    };
  }, {
    get: function get(key) {
      var entry = strong.getEntry(this, key);
      return entry && entry.v;
    },
    set: function set(key, value) {
      return strong.def(this, key === 0 ? 0 : key, value);
    }
  }, strong, true);
  global.define = __define;
  return module.exports;
});

$__System.registerDynamic("52", ["44", "42"], true, function(require, exports, module) {
  ;
  var global = this,
      __define = global.define;
  global.define = undefined;
  var forOf = require("44"),
      classof = require("42");
  module.exports = function(NAME) {
    return function toJSON() {
      if (classof(this) != NAME)
        throw TypeError(NAME + "#toJSON isn't generic");
      var arr = [];
      forOf(this, false, arr.push, arr);
      return arr;
    };
  };
  global.define = __define;
  return module.exports;
});

$__System.registerDynamic("53", ["8", "52"], true, function(require, exports, module) {
  ;
  var global = this,
      __define = global.define;
  global.define = undefined;
  var $def = require("8");
  $def($def.P, 'Map', {toJSON: require("52")('Map')});
  global.define = __define;
  return module.exports;
});

$__System.registerDynamic("54", ["1c", "4e", "39", "51", "53", "7"], true, function(require, exports, module) {
  ;
  var global = this,
      __define = global.define;
  global.define = undefined;
  require("1c");
  require("4e");
  require("39");
  require("51");
  require("53");
  module.exports = require("7").Map;
  global.define = __define;
  return module.exports;
});

$__System.registerDynamic("55", ["54"], true, function(require, exports, module) {
  ;
  var global = this,
      __define = global.define;
  global.define = undefined;
  module.exports = {
    "default": require("54"),
    __esModule: true
  };
  global.define = __define;
  return module.exports;
});

$__System.registerDynamic("59", ["8", "7", "5"], true, function(require, exports, module) {
  ;
  var global = this,
      __define = global.define;
  global.define = undefined;
  var $def = require("8"),
      core = require("7"),
      fails = require("5");
  module.exports = function(KEY, exec) {
    var $def = require("8"),
        fn = (core.Object || {})[KEY] || Object[KEY],
        exp = {};
    exp[KEY] = exec(fn);
    $def($def.S + $def.F * fails(function() {
      fn(1);
    }), 'Object', exp);
  };
  global.define = __define;
  return module.exports;
});

$__System.registerDynamic("5a", ["13", "59"], true, function(require, exports, module) {
  ;
  var global = this,
      __define = global.define;
  global.define = undefined;
  var toIObject = require("13");
  require("59")('getOwnPropertyDescriptor', function($getOwnPropertyDescriptor) {
    return function getOwnPropertyDescriptor(it, key) {
      return $getOwnPropertyDescriptor(toIObject(it), key);
    };
  });
  global.define = __define;
  return module.exports;
});

$__System.registerDynamic("5b", ["2", "5a"], true, function(require, exports, module) {
  ;
  var global = this,
      __define = global.define;
  global.define = undefined;
  var $ = require("2");
  require("5a");
  module.exports = function getOwnPropertyDescriptor(it, key) {
    return $.getDesc(it, key);
  };
  global.define = __define;
  return module.exports;
});

$__System.registerDynamic("5c", ["5b"], true, function(require, exports, module) {
  ;
  var global = this,
      __define = global.define;
  global.define = undefined;
  module.exports = {
    "default": require("5b"),
    __esModule: true
  };
  global.define = __define;
  return module.exports;
});

$__System.registerDynamic("5d", ["5c"], true, function(require, exports, module) {
  ;
  var global = this,
      __define = global.define;
  global.define = undefined;
  "use strict";
  var _Object$getOwnPropertyDescriptor = require("5c")["default"];
  exports["default"] = function get(_x, _x2, _x3) {
    var _again = true;
    _function: while (_again) {
      var object = _x,
          property = _x2,
          receiver = _x3;
      _again = false;
      if (object === null)
        object = Function.prototype;
      var desc = _Object$getOwnPropertyDescriptor(object, property);
      if (desc === undefined) {
        var parent = Object.getPrototypeOf(object);
        if (parent === null) {
          return undefined;
        } else {
          _x = parent;
          _x2 = property;
          _x3 = receiver;
          _again = true;
          desc = parent = undefined;
          continue _function;
        }
      } else if ("value" in desc) {
        return desc.value;
      } else {
        var getter = desc.get;
        if (getter === undefined) {
          return undefined;
        }
        return getter.call(receiver);
      }
    }
  };
  exports.__esModule = true;
  global.define = __define;
  return module.exports;
});

$__System.registerDynamic("5e", ["2"], true, function(require, exports, module) {
  ;
  var global = this,
      __define = global.define;
  global.define = undefined;
  var $ = require("2");
  module.exports = function create(P, D) {
    return $.create(P, D);
  };
  global.define = __define;
  return module.exports;
});

$__System.registerDynamic("5f", ["5e"], true, function(require, exports, module) {
  ;
  var global = this,
      __define = global.define;
  global.define = undefined;
  module.exports = {
    "default": require("5e"),
    __esModule: true
  };
  global.define = __define;
  return module.exports;
});

$__System.registerDynamic("60", ["2", "18", "19", "3d"], true, function(require, exports, module) {
  ;
  var global = this,
      __define = global.define;
  global.define = undefined;
  var getDesc = require("2").getDesc,
      isObject = require("18"),
      anObject = require("19");
  var check = function(O, proto) {
    anObject(O);
    if (!isObject(proto) && proto !== null)
      throw TypeError(proto + ": can't set as prototype!");
  };
  module.exports = {
    set: Object.setPrototypeOf || ('__proto__' in {} ? function(test, buggy, set) {
      try {
        set = require("3d")(Function.call, getDesc(Object.prototype, '__proto__').set, 2);
        set(test, []);
        buggy = !(test instanceof Array);
      } catch (e) {
        buggy = true;
      }
      return function setPrototypeOf(O, proto) {
        check(O, proto);
        if (buggy)
          O.__proto__ = proto;
        else
          set(O, proto);
        return O;
      };
    }({}, false) : undefined),
    check: check
  };
  global.define = __define;
  return module.exports;
});

$__System.registerDynamic("61", ["8", "60"], true, function(require, exports, module) {
  ;
  var global = this,
      __define = global.define;
  global.define = undefined;
  var $def = require("8");
  $def($def.S, 'Object', {setPrototypeOf: require("60").set});
  global.define = __define;
  return module.exports;
});

$__System.registerDynamic("62", ["61", "7"], true, function(require, exports, module) {
  ;
  var global = this,
      __define = global.define;
  global.define = undefined;
  require("61");
  module.exports = require("7").Object.setPrototypeOf;
  global.define = __define;
  return module.exports;
});

$__System.registerDynamic("63", ["62"], true, function(require, exports, module) {
  ;
  var global = this,
      __define = global.define;
  global.define = undefined;
  module.exports = {
    "default": require("62"),
    __esModule: true
  };
  global.define = __define;
  return module.exports;
});

$__System.registerDynamic("64", ["5f", "63"], true, function(require, exports, module) {
  ;
  var global = this,
      __define = global.define;
  global.define = undefined;
  "use strict";
  var _Object$create = require("5f")["default"];
  var _Object$setPrototypeOf = require("63")["default"];
  exports["default"] = function(subClass, superClass) {
    if (typeof superClass !== "function" && superClass !== null) {
      throw new TypeError("Super expression must either be null or a function, not " + typeof superClass);
    }
    subClass.prototype = _Object$create(superClass && superClass.prototype, {constructor: {
        value: subClass,
        enumerable: false,
        writable: true,
        configurable: true
      }});
    if (superClass)
      _Object$setPrototypeOf ? _Object$setPrototypeOf(subClass, superClass) : subClass.__proto__ = superClass;
  };
  exports.__esModule = true;
  global.define = __define;
  return module.exports;
});

$__System.registerDynamic("70", ["19", "43", "7"], true, function(require, exports, module) {
  ;
  var global = this,
      __define = global.define;
  global.define = undefined;
  var anObject = require("19"),
      get = require("43");
  module.exports = require("7").getIterator = function(it) {
    var iterFn = get(it);
    if (typeof iterFn != 'function')
      throw TypeError(it + ' is not iterable!');
    return anObject(iterFn.call(it));
  };
  global.define = __define;
  return module.exports;
});

$__System.registerDynamic("71", ["39", "4e", "70"], true, function(require, exports, module) {
  ;
  var global = this,
      __define = global.define;
  global.define = undefined;
  require("39");
  require("4e");
  module.exports = require("70");
  global.define = __define;
  return module.exports;
});

$__System.registerDynamic("72", ["71"], true, function(require, exports, module) {
  ;
  var global = this,
      __define = global.define;
  global.define = undefined;
  module.exports = {
    "default": require("71"),
    __esModule: true
  };
  global.define = __define;
  return module.exports;
});

$__System.register('20', ['1f'], function (_export) {
    var _Symbol;

    return {
        setters: [function (_f) {
            _Symbol = _f['default'];
        }],
        execute: function () {
            'use strict';

            _export('default', {
                SUCCESS: _Symbol('b3.status.success'),
                FAILURE: _Symbol('b3.status.failure'),
                RUNNING: _Symbol('b3.status.running'),
                ERROR: _Symbol('b3.status.error')
            });
        }
    };
});

$__System.register('21', ['1f'], function (_export) {
    var _Symbol;

    return {
        setters: [function (_f) {
            _Symbol = _f['default'];
        }],
        execute: function () {
            'use strict';

            _export('default', {
                COMPOSITE: _Symbol('b3.category.composite'),
                DECORATOR: _Symbol('b3.category.decorator'),
                ACTION: _Symbol('b3.category.action'),
                CONDITION: _Symbol('b3.category.condition')
            });
        }
    };
});

$__System.register('32', ['20', '24', '25', '31'], function (_export) {
    var STATUS, _createClass, _classCallCheck, uuid, BaseNode;

    return {
        setters: [function (_4) {
            STATUS = _4['default'];
        }, function (_) {
            _createClass = _['default'];
        }, function (_2) {
            _classCallCheck = _2['default'];
        }, function (_3) {
            uuid = _3['default'];
        }],
        execute: function () {
            'use strict';

            BaseNode = (function () {
                function BaseNode() {
                    _classCallCheck(this, BaseNode);

                    this.id = uuid();
                    this.title = '';
                    this.description = '';
                    this.parameters = {};
                    this.properties = {};
                }

                _createClass(BaseNode, [{
                    key: '_execute',
                    value: function _execute(tick) {
                        // ENTER
                        this._enter(tick);

                        // OPEN
                        if (!tick.blackboard.get('isOpen', tick.tree.id, this.id)) {
                            this._open(tick);
                        }

                        // TICK
                        var status = this._tick(tick);

                        // CLOSE
                        if (status !== STATUS.RUNNING) {
                            this._close(tick);
                        }

                        // EXIT
                        this._exit(tick);

                        return status;
                    }
                }, {
                    key: '_enter',
                    value: function _enter(tick) {
                        tick._enterNode(this);
                        this.enter(tick);
                    }
                }, {
                    key: '_open',
                    value: function _open(tick) {
                        tick._openNode(this);
                        tick.blackboard.set('isOpen', true, tick.tree.id, this.id);
                        this.open(tick);
                    }
                }, {
                    key: '_tick',
                    value: function _tick(tick) {
                        tick._tickNode(this);
                        return this.tick(tick);
                    }
                }, {
                    key: '_close',
                    value: function _close(tick) {
                        tick._closeNode(this);
                        tick.blackboard.set('isOpen', false, tick.tree.id, this.id);
                        this.close(tick);
                    }
                }, {
                    key: '_exit',
                    value: function _exit(tick) {
                        tick._exitNode(this);
                        this.exit(tick);
                    }
                }, {
                    key: 'enter',
                    value: function enter(tick) {
                        // subclass implements
                    }
                }, {
                    key: 'open',
                    value: function open(tick) {
                        // subclass implements
                    }
                }, {
                    key: 'tick',
                    value: function tick(_tick2) {
                        // subclass implements
                    }
                }, {
                    key: 'close',
                    value: function close(tick) {
                        // subclass implements
                    }
                }, {
                    key: 'exit',
                    value: function exit(tick) {
                        // subclass implements
                    }
                }]);

                return BaseNode;
            })();

            _export('default', BaseNode);

            ;
        }
    };
});

$__System.register('56', ['24', '25', '55', '4c'], function (_export) {
    var _createClass, _classCallCheck, _Map, _WeakMap, baseMemory, treeMemory, Blackboard;

    return {
        setters: [function (_) {
            _createClass = _['default'];
        }, function (_2) {
            _classCallCheck = _2['default'];
        }, function (_3) {
            _Map = _3['default'];
        }, function (_c) {
            _WeakMap = _c['default'];
        }],
        execute: function () {
            'use strict';

            baseMemory = new _WeakMap();
            treeMemory = new _WeakMap();

            Blackboard = (function () {
                function Blackboard() {
                    _classCallCheck(this, Blackboard);

                    baseMemory.set(this, new _Map());
                    treeMemory.set(this, new _Map());
                }

                _createClass(Blackboard, [{
                    key: '_getTreeMemory',
                    value: function _getTreeMemory(treeScope) {
                        var memory = treeMemory.get(this);

                        if (!memory.has(treeScope)) {
                            memory.set(treeScope, {
                                'nodeMemory': new _Map(),
                                'openNodes': [],
                                'traversalDepth': 0,
                                'traversalCycle': 0
                            });
                        }

                        return memory.get(treeScope);
                    }
                }, {
                    key: '_getNodeMemory',
                    value: function _getNodeMemory(treeMemory, nodeScope) {
                        var memory = treeMemory.get('nodeMemory');
                        if (!memory.has(nodeScope)) {
                            memory.set(nodeScope, new _Map());
                        }

                        return memory.get(nodeScope);
                    }
                }, {
                    key: '_getMemory',
                    value: function _getMemory(treeScope, nodeScope) {
                        var memory = baseMemory.get(this);

                        if (treeScope) {
                            memory = this._getTreeMemory(treeScope);

                            if (nodeScope) {
                                memory = this._getNodeMemory(memory, nodeScope);
                            }
                        }

                        return memory;
                    }
                }, {
                    key: 'set',
                    value: function set(key, value, treeScope, nodeScope) {
                        var memory = this._getMemory(treeScope, nodeScope);
                        memory.set(key, value);
                    }
                }, {
                    key: 'get',
                    value: function get(key, treeScope, nodeScope) {
                        var memory = this._getMemory(treeScope, nodeScope);
                        return memory.get(key);
                    }
                }]);

                return Blackboard;
            })();

            _export('default', Blackboard);

            ;
        }
    };
});

$__System.register('57', ['24', '25'], function (_export) {
    var _createClass, _classCallCheck, Tick;

    return {
        setters: [function (_) {
            _createClass = _['default'];
        }, function (_2) {
            _classCallCheck = _2['default'];
        }],
        execute: function () {
            'use strict';

            Tick = (function () {
                function Tick() {
                    _classCallCheck(this, Tick);

                    // set by BehaviorTree
                    this.tree = null;
                    this.debug = null;
                    this.target = null;
                    this.blackboard = null;

                    // updated during the tick signal
                    this._openNodes = [];
                    this._nodeCount = 0;
                }

                _createClass(Tick, [{
                    key: '_enterNode',
                    value: function _enterNode(node) {
                        this._nodeCount++;
                        this._openNodes.push(node);
                    }
                }, {
                    key: '_openNode',
                    value: function _openNode(node) {}
                }, {
                    key: '_tickNode',
                    value: function _tickNode(node) {}
                }, {
                    key: '_closeNode',
                    value: function _closeNode(node) {
                        this._openNodes.pop();
                    }
                }, {
                    key: '_exitNode',
                    value: function _exitNode(node) {}
                }]);

                return Tick;
            })();

            _export('default', Tick);

            ;
        }
    };
});

$__System.register('58', ['24', '25', '31', '56', '57'], function (_export) {
    var _createClass, _classCallCheck, uuid, Blackboard, Tick, BehaviorTree;

    return {
        setters: [function (_) {
            _createClass = _['default'];
        }, function (_2) {
            _classCallCheck = _2['default'];
        }, function (_3) {
            uuid = _3['default'];
        }, function (_4) {
            Blackboard = _4['default'];
        }, function (_5) {
            Tick = _5['default'];
        }],
        execute: function () {
            'use strict';

            BehaviorTree = (function () {
                function BehaviorTree() {
                    _classCallCheck(this, BehaviorTree);

                    this.id = uuid();
                    this.title = 'The behavior tree';
                    this.description = 'Default description';
                    this.properties = {};
                    this.root = null;
                    this.debug = null;
                }

                _createClass(BehaviorTree, [{
                    key: 'tick',
                    value: function tick(target, blackboard) {
                        if (!blackboard || !blackboard instanceof Blackboard) {
                            throw 'The blackboard parameter is required and must be an instance of Blackboard';
                        }

                        var tick = new Tick();
                        tick.debug = this.debug;
                        tick.target = target;
                        tick.blackboard = blackboard;
                        tick.tree = this;

                        var state = this.root._execute(tick);

                        // close nodes from last tick if needed
                        var lastOpenNodes = blackboard.get('openNodes', this.id);
                        var currOpenNodes = tick._openNodes.slice(0);

                        // does not close if it is still open in this tick
                        var start = 0;
                        var len = Math.min(lastOpenNodes.length, currOpenNodes.length);
                        for (var i = 0; i < len; i++) {
                            start = i + 1;
                            if (lastOpenNodes[i] !== currOpenNodes[i]) {
                                break;
                            }
                        }

                        for (var i = lastOpenNodes.length - 1; i >= start; i--) {
                            lastOpenNodes[i]._close(tick);
                        }

                        blackboard.set('openNodes', currOpenNodes, this.id);
                        blackboard.set('nodeCount', tick._nodeCount, this.id);

                        return state;
                    }
                }]);

                return BehaviorTree;
            })();

            _export('default', BehaviorTree);

            ;
        }
    };
});

$__System.register('65', ['21', '25', '32', '64', '5d'], function (_export) {
    var category, _classCallCheck, BaseNode, _inherits, _get, Action;

    return {
        setters: [function (_4) {
            category = _4['default'];
        }, function (_2) {
            _classCallCheck = _2['default'];
        }, function (_3) {
            BaseNode = _3['default'];
        }, function (_) {
            _inherits = _['default'];
        }, function (_d) {
            _get = _d['default'];
        }],
        execute: function () {
            'use strict';

            Action = (function (_BaseNode) {
                _inherits(Action, _BaseNode);

                function Action() {
                    _classCallCheck(this, Action);

                    _get(Object.getPrototypeOf(Action.prototype), 'constructor', this).call(this);

                    this.category = category.ACTION;
                }

                return Action;
            })(BaseNode);

            _export('default', Action);

            ;
        }
    };
});

$__System.register('66', ['21', '25', '32', '64', '5d'], function (_export) {
    var category, _classCallCheck, BaseNode, _inherits, _get, Composite;

    return {
        setters: [function (_4) {
            category = _4['default'];
        }, function (_2) {
            _classCallCheck = _2['default'];
        }, function (_3) {
            BaseNode = _3['default'];
        }, function (_) {
            _inherits = _['default'];
        }, function (_d) {
            _get = _d['default'];
        }],
        execute: function () {
            'use strict';

            Composite = (function (_BaseNode) {
                _inherits(Composite, _BaseNode);

                function Composite() {
                    var params = arguments.length <= 0 || arguments[0] === undefined ? { children: [] } : arguments[0];

                    _classCallCheck(this, Composite);

                    _get(Object.getPrototypeOf(Composite.prototype), 'constructor', this).call(this);

                    this.category = category.COMPOSITE;
                    this.children = params.children;
                }

                return Composite;
            })(BaseNode);

            _export('default', Composite);

            ;
        }
    };
});

$__System.register('67', ['21', '25', '32', '64', '5d'], function (_export) {
    var category, _classCallCheck, BaseNode, _inherits, _get, Condition;

    return {
        setters: [function (_4) {
            category = _4['default'];
        }, function (_2) {
            _classCallCheck = _2['default'];
        }, function (_3) {
            BaseNode = _3['default'];
        }, function (_) {
            _inherits = _['default'];
        }, function (_d) {
            _get = _d['default'];
        }],
        execute: function () {
            'use strict';

            Condition = (function (_BaseNode) {
                _inherits(Condition, _BaseNode);

                function Condition() {
                    _classCallCheck(this, Condition);

                    _get(Object.getPrototypeOf(Condition.prototype), 'constructor', this).call(this);

                    this.category = category.CONDITION;
                }

                return Condition;
            })(BaseNode);

            _export('default', Condition);

            ;
        }
    };
});

$__System.register('68', ['21', '25', '32', '64', '5d'], function (_export) {
    var category, _classCallCheck, BaseNode, _inherits, _get, Decorator;

    return {
        setters: [function (_4) {
            category = _4['default'];
        }, function (_2) {
            _classCallCheck = _2['default'];
        }, function (_3) {
            BaseNode = _3['default'];
        }, function (_) {
            _inherits = _['default'];
        }, function (_d) {
            _get = _d['default'];
        }],
        execute: function () {
            'use strict';

            Decorator = (function (_BaseNode) {
                _inherits(Decorator, _BaseNode);

                function Decorator() {
                    var params = arguments.length <= 0 || arguments[0] === undefined ? { child: null } : arguments[0];

                    _classCallCheck(this, Decorator);

                    _get(Object.getPrototypeOf(Decorator.prototype), 'constructor', this).call(this);

                    this.category = category.DECORATOR;
                    this.child = params.child;
                }

                return Decorator;
            })(BaseNode);

            _export('default', Decorator);

            ;
        }
    };
});

$__System.register('69', ['20', '24', '25', '64', '65', '5d'], function (_export) {
    var status, _createClass, _classCallCheck, _inherits, Action, _get, Error;

    return {
        setters: [function (_5) {
            status = _5['default'];
        }, function (_2) {
            _createClass = _2['default'];
        }, function (_3) {
            _classCallCheck = _3['default'];
        }, function (_) {
            _inherits = _['default'];
        }, function (_4) {
            Action = _4['default'];
        }, function (_d) {
            _get = _d['default'];
        }],
        execute: function () {
            'use strict';

            Error = (function (_Action) {
                _inherits(Error, _Action);

                function Error() {
                    _classCallCheck(this, Error);

                    _get(Object.getPrototypeOf(Error.prototype), 'constructor', this).apply(this, arguments);
                }

                _createClass(Error, [{
                    key: 'tick',
                    value: function tick(_tick) {
                        return status.ERROR;
                    }
                }]);

                return Error;
            })(Action);

            _export('default', Error);

            ;
        }
    };
});

$__System.register('6a', ['20', '24', '25', '64', '65', '5d'], function (_export) {
    var status, _createClass, _classCallCheck, _inherits, Action, _get, Failer;

    return {
        setters: [function (_5) {
            status = _5['default'];
        }, function (_2) {
            _createClass = _2['default'];
        }, function (_3) {
            _classCallCheck = _3['default'];
        }, function (_) {
            _inherits = _['default'];
        }, function (_4) {
            Action = _4['default'];
        }, function (_d) {
            _get = _d['default'];
        }],
        execute: function () {
            'use strict';

            Failer = (function (_Action) {
                _inherits(Failer, _Action);

                function Failer() {
                    _classCallCheck(this, Failer);

                    _get(Object.getPrototypeOf(Failer.prototype), 'constructor', this).apply(this, arguments);
                }

                _createClass(Failer, [{
                    key: 'tick',
                    value: function tick(_tick) {
                        return status.FAILURE;
                    }
                }]);

                return Failer;
            })(Action);

            _export('default', Failer);

            ;
        }
    };
});

$__System.register('6b', ['20', '24', '25', '64', '65', '5d'], function (_export) {
    var status, _createClass, _classCallCheck, _inherits, Action, _get, Runner;

    return {
        setters: [function (_5) {
            status = _5['default'];
        }, function (_2) {
            _createClass = _2['default'];
        }, function (_3) {
            _classCallCheck = _3['default'];
        }, function (_) {
            _inherits = _['default'];
        }, function (_4) {
            Action = _4['default'];
        }, function (_d) {
            _get = _d['default'];
        }],
        execute: function () {
            'use strict';

            Runner = (function (_Action) {
                _inherits(Runner, _Action);

                function Runner() {
                    _classCallCheck(this, Runner);

                    _get(Object.getPrototypeOf(Runner.prototype), 'constructor', this).apply(this, arguments);
                }

                _createClass(Runner, [{
                    key: 'tick',
                    value: function tick(_tick) {
                        return status.RUNNING;
                    }
                }]);

                return Runner;
            })(Action);

            _export('default', Runner);

            ;
        }
    };
});

$__System.register('6c', ['20', '24', '25', '64', '65', '5d'], function (_export) {
    var status, _createClass, _classCallCheck, _inherits, Action, _get, Succeeder;

    return {
        setters: [function (_5) {
            status = _5['default'];
        }, function (_2) {
            _createClass = _2['default'];
        }, function (_3) {
            _classCallCheck = _3['default'];
        }, function (_) {
            _inherits = _['default'];
        }, function (_4) {
            Action = _4['default'];
        }, function (_d) {
            _get = _d['default'];
        }],
        execute: function () {
            'use strict';

            Succeeder = (function (_Action) {
                _inherits(Succeeder, _Action);

                function Succeeder() {
                    _classCallCheck(this, Succeeder);

                    _get(Object.getPrototypeOf(Succeeder.prototype), 'constructor', this).apply(this, arguments);
                }

                _createClass(Succeeder, [{
                    key: 'tick',
                    value: function tick(_tick) {
                        return status.SUCCESS;
                    }
                }]);

                return Succeeder;
            })(Action);

            _export('default', Succeeder);

            ;
        }
    };
});

$__System.register('6d', ['20', '24', '25', '64', '65', '5d'], function (_export) {
    var status, _createClass, _classCallCheck, _inherits, Action, _get, Wait;

    return {
        setters: [function (_5) {
            status = _5['default'];
        }, function (_2) {
            _createClass = _2['default'];
        }, function (_3) {
            _classCallCheck = _3['default'];
        }, function (_) {
            _inherits = _['default'];
        }, function (_4) {
            Action = _4['default'];
        }, function (_d) {
            _get = _d['default'];
        }],
        execute: function () {
            'use strict';

            Wait = (function (_Action) {
                _inherits(Wait, _Action);

                function Wait() {
                    var settings = arguments.length <= 0 || arguments[0] === undefined ? { milliseconds: 0 } : arguments[0];

                    _classCallCheck(this, Wait);

                    _get(Object.getPrototypeOf(Wait.prototype), 'constructor', this).call(this);

                    this.title = 'Wait <milliseconds>ms';
                    this.parameters = { 'milliseconds': 0 };

                    this.endTime = settings.milliseconds;
                }

                _createClass(Wait, [{
                    key: 'open',
                    value: function open(tick) {
                        var startTime = new Date().getTime();
                        tick.blackboard.set('startTime', startTime, tick.tree.id, this.id);
                    }
                }, {
                    key: 'tick',
                    value: function tick(_tick) {
                        var currTime = new Date().getTime();
                        var startTime = _tick.blackboard.get('startTime', _tick.tree.id, this.id);

                        if (currTime - startTime > this.endTime) {
                            return status.SUCCESS;
                        }

                        return status.RUNNING;
                    }
                }]);

                return Wait;
            })(Action);

            _export('default', Wait);

            ;
        }
    };
});

$__System.register('6e', ['20', '24', '25', '64', '66', '5d'], function (_export) {
    var status, _createClass, _classCallCheck, _inherits, Composite, _get, MemPriority;

    return {
        setters: [function (_4) {
            status = _4['default'];
        }, function (_2) {
            _createClass = _2['default'];
        }, function (_3) {
            _classCallCheck = _3['default'];
        }, function (_) {
            _inherits = _['default'];
        }, function (_5) {
            Composite = _5['default'];
        }, function (_d) {
            _get = _d['default'];
        }],
        execute: function () {
            'use strict';

            MemPriority = (function (_Composite) {
                _inherits(MemPriority, _Composite);

                function MemPriority() {
                    _classCallCheck(this, MemPriority);

                    _get(Object.getPrototypeOf(MemPriority.prototype), 'constructor', this).apply(this, arguments);
                }

                _createClass(MemPriority, [{
                    key: 'open',
                    value: function open(tick) {
                        tick.blackboard.set('runningChild', 0, tick.tree.id, this.id);
                    }
                }, {
                    key: 'tick',
                    value: function tick(_tick) {
                        var runningChild = _tick.blackboard.get('runningChild', _tick.tree.id, this.id);

                        for (var i = runningChild, len = this.children.length; i < len; i++) {
                            var childStatus = this.children[i]._execute(_tick);

                            if (childStatus !== status.FAILURE) {
                                if (childStatus === status.RUNNING) {
                                    _tick.blackboard.set('runningChild', i, _tick.tree.id, this.id);
                                }
                                return childStatus;
                            }
                        }

                        return status.FAILURE;
                    }
                }]);

                return MemPriority;
            })(Composite);

            _export('default', MemPriority);

            ;
        }
    };
});

$__System.register('6f', ['20', '24', '25', '64', '66', '5d'], function (_export) {
    var status, _createClass, _classCallCheck, _inherits, Composite, _get, MemSequence;

    return {
        setters: [function (_4) {
            status = _4['default'];
        }, function (_2) {
            _createClass = _2['default'];
        }, function (_3) {
            _classCallCheck = _3['default'];
        }, function (_) {
            _inherits = _['default'];
        }, function (_5) {
            Composite = _5['default'];
        }, function (_d) {
            _get = _d['default'];
        }],
        execute: function () {
            'use strict';

            MemSequence = (function (_Composite) {
                _inherits(MemSequence, _Composite);

                function MemSequence() {
                    _classCallCheck(this, MemSequence);

                    _get(Object.getPrototypeOf(MemSequence.prototype), 'constructor', this).apply(this, arguments);
                }

                _createClass(MemSequence, [{
                    key: 'open',
                    value: function open(tick) {
                        tick.blackboard.set('runningChild', 0, tick.tree.id, this.id);
                    }
                }, {
                    key: 'tick',
                    value: function tick(_tick) {
                        var runningChild = _tick.blackboard.get('runningChild', _tick.tree.id, this.id);

                        for (var i = runningChild, len = this.children.length; i < len; i++) {
                            var childStatus = this.children[i]._execute(_tick);

                            if (childStatus !== status.SUCCESS) {
                                if (childStatus === status.RUNNING) {
                                    _tick.blackboard.set('runningChild', i, _tick.tree.id, this.id);
                                }
                                return childStatus;
                            }
                        }

                        return status.SUCCESS;
                    }
                }]);

                return MemSequence;
            })(Composite);

            _export('default', MemSequence);

            ;
        }
    };
});

$__System.register('73', ['20', '24', '25', '64', '66', '72', '5d'], function (_export) {
    var status, _createClass, _classCallCheck, _inherits, Composite, _getIterator, _get, Priority;

    return {
        setters: [function (_5) {
            status = _5['default'];
        }, function (_2) {
            _createClass = _2['default'];
        }, function (_3) {
            _classCallCheck = _3['default'];
        }, function (_) {
            _inherits = _['default'];
        }, function (_6) {
            Composite = _6['default'];
        }, function (_4) {
            _getIterator = _4['default'];
        }, function (_d) {
            _get = _d['default'];
        }],
        execute: function () {
            'use strict';

            Priority = (function (_Composite) {
                _inherits(Priority, _Composite);

                function Priority() {
                    _classCallCheck(this, Priority);

                    _get(Object.getPrototypeOf(Priority.prototype), 'constructor', this).apply(this, arguments);
                }

                _createClass(Priority, [{
                    key: 'tick',
                    value: function tick(_tick) {
                        var _iteratorNormalCompletion = true;
                        var _didIteratorError = false;
                        var _iteratorError = undefined;

                        try {
                            for (var _iterator = _getIterator(this.children), _step; !(_iteratorNormalCompletion = (_step = _iterator.next()).done); _iteratorNormalCompletion = true) {
                                var child = _step.value;

                                var childStatus = child._execute(_tick);
                                if (childStatus !== status.FAILURE) {
                                    return childStatus;
                                }
                            }
                        } catch (err) {
                            _didIteratorError = true;
                            _iteratorError = err;
                        } finally {
                            try {
                                if (!_iteratorNormalCompletion && _iterator['return']) {
                                    _iterator['return']();
                                }
                            } finally {
                                if (_didIteratorError) {
                                    throw _iteratorError;
                                }
                            }
                        }

                        return status.FAILURE;
                    }
                }]);

                return Priority;
            })(Composite);

            _export('default', Priority);

            ;
        }
    };
});

$__System.register('74', ['20', '24', '25', '64', '66', '72', '5d'], function (_export) {
    var status, _createClass, _classCallCheck, _inherits, Composite, _getIterator, _get, Sequence;

    return {
        setters: [function (_5) {
            status = _5['default'];
        }, function (_2) {
            _createClass = _2['default'];
        }, function (_3) {
            _classCallCheck = _3['default'];
        }, function (_) {
            _inherits = _['default'];
        }, function (_6) {
            Composite = _6['default'];
        }, function (_4) {
            _getIterator = _4['default'];
        }, function (_d) {
            _get = _d['default'];
        }],
        execute: function () {
            'use strict';

            Sequence = (function (_Composite) {
                _inherits(Sequence, _Composite);

                function Sequence() {
                    _classCallCheck(this, Sequence);

                    _get(Object.getPrototypeOf(Sequence.prototype), 'constructor', this).apply(this, arguments);
                }

                _createClass(Sequence, [{
                    key: 'tick',
                    value: function tick(_tick) {
                        var _iteratorNormalCompletion = true;
                        var _didIteratorError = false;
                        var _iteratorError = undefined;

                        try {
                            for (var _iterator = _getIterator(this.children), _step; !(_iteratorNormalCompletion = (_step = _iterator.next()).done); _iteratorNormalCompletion = true) {
                                var child = _step.value;

                                var childStatus = child._execute(_tick);
                                if (childStatus !== status.SUCCESS) {
                                    return childStatus;
                                }
                            }
                        } catch (err) {
                            _didIteratorError = true;
                            _iteratorError = err;
                        } finally {
                            try {
                                if (!_iteratorNormalCompletion && _iterator['return']) {
                                    _iterator['return']();
                                }
                            } finally {
                                if (_didIteratorError) {
                                    throw _iteratorError;
                                }
                            }
                        }

                        return status.SUCCESS;
                    }
                }]);

                return Sequence;
            })(Composite);

            _export('default', Sequence);

            ;
        }
    };
});

$__System.register('75', ['20', '24', '25', '64', '68', '5d'], function (_export) {
    var status, _createClass, _classCallCheck, _inherits, Decorator, _get, Inverter;

    return {
        setters: [function (_4) {
            status = _4['default'];
        }, function (_2) {
            _createClass = _2['default'];
        }, function (_3) {
            _classCallCheck = _3['default'];
        }, function (_) {
            _inherits = _['default'];
        }, function (_5) {
            Decorator = _5['default'];
        }, function (_d) {
            _get = _d['default'];
        }],
        execute: function () {
            'use strict';

            Inverter = (function (_Decorator) {
                _inherits(Inverter, _Decorator);

                function Inverter() {
                    _classCallCheck(this, Inverter);

                    _get(Object.getPrototypeOf(Inverter.prototype), 'constructor', this).apply(this, arguments);
                }

                _createClass(Inverter, [{
                    key: 'tick',
                    value: function tick(_tick) {
                        if (!this.child) {
                            return status.ERROR;
                        }

                        var childStatus = this.child._execute(_tick);

                        if (childStatus === status.SUCCESS) {
                            childStatus = status.FAILURE;
                        } else if (childStatus === status.FAILURE) {
                            childStatus = status.SUCCESS;
                        }

                        return childStatus;
                    }
                }]);

                return Inverter;
            })(Decorator);

            _export('default', Inverter);

            ;
        }
    };
});

$__System.register('76', ['20', '24', '25', '64', '68', '5d'], function (_export) {
    var status, _createClass, _classCallCheck, _inherits, Decorator, _get, Limiter;

    return {
        setters: [function (_4) {
            status = _4['default'];
        }, function (_2) {
            _createClass = _2['default'];
        }, function (_3) {
            _classCallCheck = _3['default'];
        }, function (_) {
            _inherits = _['default'];
        }, function (_5) {
            Decorator = _5['default'];
        }, function (_d) {
            _get = _d['default'];
        }],
        execute: function () {
            'use strict';

            Limiter = (function (_Decorator) {
                _inherits(Limiter, _Decorator);

                function Limiter() {
                    var params = arguments.length <= 0 || arguments[0] === undefined ? { maxLoop: 1 } : arguments[0];

                    _classCallCheck(this, Limiter);

                    _get(Object.getPrototypeOf(Limiter.prototype), 'constructor', this).call(this);

                    this.title = 'Limit <maxLoop> Activations';
                    this.parameters = {
                        maxLoop: 1
                    };

                    this.maxLoop = params.maxLoop;
                }

                _createClass(Limiter, [{
                    key: 'open',
                    value: function open(tick) {
                        tick.blackboard.set('loopCount', 0, tick.tree.id, this.id);
                    }
                }, {
                    key: 'tick',
                    value: function tick(_tick) {
                        if (!this.child) {
                            return status.ERROR;
                        }

                        var loopCount = _tick.blackboard.get('loopCount', _tick.tree.id, this.id);

                        if (loopCount < this.maxLoop) {
                            var childStatus = this.child._execute(_tick);

                            if (childStatus === status.SUCCESS || childStatus === status.FAILURE) {
                                _tick.blackboard.set('loopCount', loopCount + 1, _tick.tree.id, this.id);
                            }

                            return childStatus;
                        }

                        return status.FAILURE;
                    }
                }]);

                return Limiter;
            })(Decorator);

            _export('default', Limiter);
        }
    };
});

$__System.register('77', ['20', '24', '25', '64', '68', '5d'], function (_export) {
    var status, _createClass, _classCallCheck, _inherits, Decorator, _get, MaxTime;

    return {
        setters: [function (_4) {
            status = _4['default'];
        }, function (_2) {
            _createClass = _2['default'];
        }, function (_3) {
            _classCallCheck = _3['default'];
        }, function (_) {
            _inherits = _['default'];
        }, function (_5) {
            Decorator = _5['default'];
        }, function (_d) {
            _get = _d['default'];
        }],
        execute: function () {
            'use strict';

            MaxTime = (function (_Decorator) {
                _inherits(MaxTime, _Decorator);

                function MaxTime() {
                    var params = arguments.length <= 0 || arguments[0] === undefined ? { maxTime: 0 } : arguments[0];

                    _classCallCheck(this, MaxTime);

                    _get(Object.getPrototypeOf(MaxTime.prototype), 'constructor', this).call(this);

                    this.title = 'Max <maxTime>ms';
                    this.parameters = { maxTime: 0 };

                    this.maxTime = params.maxTime;
                }

                _createClass(MaxTime, [{
                    key: 'open',
                    value: function open(tick) {
                        var startTime = new Date().getTime();
                        tick.blackboard.set('startTime', startTime, tick.tree.id, this.id);
                    }
                }, {
                    key: 'tick',
                    value: function tick(_tick) {
                        if (!this.child) {
                            return status.ERROR;
                        }

                        var currTime = new Date().getTime();
                        var startTime = _tick.blackboard.get('startTime', _tick.tree.id, this.id);

                        var childStatus = this.child._execute(_tick);
                        if (currTime - startTime > this.maxTime) {
                            return status.FAILURE;
                        }

                        return childStatus;
                    }
                }]);

                return MaxTime;
            })(Decorator);

            _export('default', MaxTime);

            ;
        }
    };
});

$__System.register('78', ['20', '24', '25', '64', '68', '5d'], function (_export) {
    var status, _createClass, _classCallCheck, _inherits, Decorator, _get, Repeater;

    return {
        setters: [function (_4) {
            status = _4['default'];
        }, function (_2) {
            _createClass = _2['default'];
        }, function (_3) {
            _classCallCheck = _3['default'];
        }, function (_) {
            _inherits = _['default'];
        }, function (_5) {
            Decorator = _5['default'];
        }, function (_d) {
            _get = _d['default'];
        }],
        execute: function () {
            'use strict';

            Repeater = (function (_Decorator) {
                _inherits(Repeater, _Decorator);

                function Repeater() {
                    var params = arguments.length <= 0 || arguments[0] === undefined ? { maxLoop: -1 } : arguments[0];

                    _classCallCheck(this, Repeater);

                    _get(Object.getPrototypeOf(Repeater.prototype), 'constructor', this).call(this);

                    this.title = 'Repeat <maxLoop>x';
                    this.parameters = { maxLoop: -1 };

                    this.maxLoop = params.maxLoop;
                }

                _createClass(Repeater, [{
                    key: 'open',
                    value: function open(tick) {
                        tick.blackboard.set('loopCount', 0, tick.tree.id, this.id);
                    }
                }, {
                    key: 'tick',
                    value: function tick(_tick) {
                        if (!this.child) {
                            return status.ERROR;
                        }

                        var loopCount = _tick.blackboard.get('loopCount', _tick.tree.id, this.id);
                        var childStatus = status.SUCCESS;

                        while (this.maxLoop < 0 || loopCount < this.maxLoop) {
                            childStatus = this.child._execute(_tick);

                            if (childStatus === status.SUCCESS || childStatus === status.FAILURE) {
                                loopCount++;
                            } else {
                                break;
                            }
                        }

                        loopCount = _tick.blackboard.set('loopCount', loopCount, _tick.tree.id, this.id);
                        return childStatus;
                    }
                }]);

                return Repeater;
            })(Decorator);

            _export('default', Repeater);

            ;
        }
    };
});

$__System.register('79', ['20', '24', '25', '64', '68', '5d'], function (_export) {
    var status, _createClass, _classCallCheck, _inherits, Decorator, _get, RepeatUntilFailure;

    return {
        setters: [function (_4) {
            status = _4['default'];
        }, function (_2) {
            _createClass = _2['default'];
        }, function (_3) {
            _classCallCheck = _3['default'];
        }, function (_) {
            _inherits = _['default'];
        }, function (_5) {
            Decorator = _5['default'];
        }, function (_d) {
            _get = _d['default'];
        }],
        execute: function () {
            'use strict';

            RepeatUntilFailure = (function (_Decorator) {
                _inherits(RepeatUntilFailure, _Decorator);

                function RepeatUntilFailure() {
                    var params = arguments.length <= 0 || arguments[0] === undefined ? { maxLoop: -1 } : arguments[0];

                    _classCallCheck(this, RepeatUntilFailure);

                    _get(Object.getPrototypeOf(RepeatUntilFailure.prototype), 'constructor', this).call(this);

                    this.title = 'Repeat Until Failure';
                    this.parameters = { maxLoop: -1 };

                    this.maxLoop = params.maxLoop;
                }

                _createClass(RepeatUntilFailure, [{
                    key: 'open',
                    value: function open(tick) {
                        tick.blackboard.set('loopCount', 0, tick.tree.id, this.id);
                    }
                }, {
                    key: 'tick',
                    value: function tick(_tick) {
                        if (!this.child) {
                            return status.ERROR;
                        }

                        var loopCount = _tick.blackboard.get('loopCount', _tick.tree.id, this.id);
                        var childStatus = status.ERROR;

                        while (this.maxLoop < 0 || loopCount < this.maxLoop) {
                            childStatus = this.child._execute(_tick);

                            if (childStatus === status.SUCCESS) {
                                loopCount++;
                            } else {
                                break;
                            }
                        }

                        loopCount = _tick.blackboard.set('loopCount', loopCount, _tick.tree.id, this.id);
                        return childStatus;
                    }
                }]);

                return RepeatUntilFailure;
            })(Decorator);

            _export('default', RepeatUntilFailure);

            ;
        }
    };
});

$__System.register('7a', ['20', '24', '25', '64', '68', '5d'], function (_export) {
    var status, _createClass, _classCallCheck, _inherits, Decorator, _get, RepeatUntilSuccess;

    return {
        setters: [function (_4) {
            status = _4['default'];
        }, function (_2) {
            _createClass = _2['default'];
        }, function (_3) {
            _classCallCheck = _3['default'];
        }, function (_) {
            _inherits = _['default'];
        }, function (_5) {
            Decorator = _5['default'];
        }, function (_d) {
            _get = _d['default'];
        }],
        execute: function () {
            'use strict';

            RepeatUntilSuccess = (function (_Decorator) {
                _inherits(RepeatUntilSuccess, _Decorator);

                function RepeatUntilSuccess() {
                    var params = arguments.length <= 0 || arguments[0] === undefined ? { maxLoop: -1 } : arguments[0];

                    _classCallCheck(this, RepeatUntilSuccess);

                    _get(Object.getPrototypeOf(RepeatUntilSuccess.prototype), 'constructor', this).call(this);

                    this.title = 'Repeat Until Success';
                    this.parameters = { maxLoop: -1 };

                    this.maxLoop = params.maxLoop;
                }

                _createClass(RepeatUntilSuccess, [{
                    key: 'open',
                    value: function open(tick) {
                        tick.blackboard.set('loopCount', 0, tick.tree.id, this.id);
                    }
                }, {
                    key: 'tick',
                    value: function tick(_tick) {
                        if (!this.child) {
                            return status.ERROR;
                        }

                        var loopCount = _tick.blackboard.get('loopCount', _tick.tree.id, this.id);
                        var childStatus = status.ERROR;

                        while (this.maxLoop < 0 || loopCount < this.maxLoop) {
                            childStatus = this.child._execute(_tick);

                            if (childStatus === status.FAILURE) {
                                loopCount++;
                            } else {
                                break;
                            }
                        }

                        loopCount = _tick.blackboard.set('loopCount', loopCount, _tick.tree.id, this.id);
                        return childStatus;
                    }
                }]);

                return RepeatUntilSuccess;
            })(Decorator);

            _export('default', RepeatUntilSuccess);

            ;
        }
    };
});

$__System.register('7b', ['20', '21', '32', '56', '57', '58', '65', '66', '67', '68', '69', '73', '74', '75', '76', '77', '78', '79', '6a', '6b', '6c', '6d', '6e', '6f', '7a'], function (_export) {
  'use strict';

  return {
    setters: [function (_) {
      var _exportObj = {};
      _exportObj['STATUS'] = _['default'];

      _export(_exportObj);
    }, function (_2) {
      var _exportObj2 = {};
      _exportObj2['CATEGORY'] = _2['default'];

      _export(_exportObj2);
    }, function (_3) {
      var _exportObj3 = {};
      _exportObj3['BaseNode'] = _3['default'];

      _export(_exportObj3);
    }, function (_5) {
      var _exportObj4 = {};
      _exportObj4['Blackboard'] = _5['default'];

      _export(_exportObj4);
    }, function (_6) {
      var _exportObj5 = {};
      _exportObj5['Tick'] = _6['default'];

      _export(_exportObj5);
    }, function (_4) {
      var _exportObj6 = {};
      _exportObj6['BehaviorTree'] = _4['default'];

      _export(_exportObj6);
    }, function (_7) {
      var _exportObj7 = {};
      _exportObj7['Action'] = _7['default'];

      _export(_exportObj7);
    }, function (_8) {
      var _exportObj8 = {};
      _exportObj8['Composite'] = _8['default'];

      _export(_exportObj8);
    }, function (_9) {
      var _exportObj9 = {};
      _exportObj9['Condition'] = _9['default'];

      _export(_exportObj9);
    }, function (_10) {
      var _exportObj10 = {};
      _exportObj10['Decorator'] = _10['default'];

      _export(_exportObj10);
    }, function (_11) {
      var _exportObj11 = {};
      _exportObj11['Error'] = _11['default'];

      _export(_exportObj11);
    }, function (_12) {
      var _exportObj12 = {};
      _exportObj12['Priority'] = _12['default'];

      _export(_exportObj12);
    }, function (_13) {
      var _exportObj13 = {};
      _exportObj13['Sequence'] = _13['default'];

      _export(_exportObj13);
    }, function (_14) {
      var _exportObj14 = {};
      _exportObj14['Inverter'] = _14['default'];

      _export(_exportObj14);
    }, function (_15) {
      var _exportObj15 = {};
      _exportObj15['Limiter'] = _15['default'];

      _export(_exportObj15);
    }, function (_16) {
      var _exportObj16 = {};
      _exportObj16['MaxTime'] = _16['default'];

      _export(_exportObj16);
    }, function (_17) {
      var _exportObj17 = {};
      _exportObj17['Repeater'] = _17['default'];

      _export(_exportObj17);
    }, function (_18) {
      var _exportObj18 = {};
      _exportObj18['RepeatUntilFailure'] = _18['default'];

      _export(_exportObj18);
    }, function (_a) {
      var _exportObj19 = {};
      _exportObj19['Failer'] = _a['default'];

      _export(_exportObj19);
    }, function (_b) {
      var _exportObj20 = {};
      _exportObj20['Runner'] = _b['default'];

      _export(_exportObj20);
    }, function (_c) {
      var _exportObj21 = {};
      _exportObj21['Succeeder'] = _c['default'];

      _export(_exportObj21);
    }, function (_d) {
      var _exportObj22 = {};
      _exportObj22['Wait'] = _d['default'];

      _export(_exportObj22);
    }, function (_e) {
      var _exportObj23 = {};
      _exportObj23['MemPriority'] = _e['default'];

      _export(_exportObj23);
    }, function (_f) {
      var _exportObj24 = {};
      _exportObj24['MemSequence'] = _f['default'];

      _export(_exportObj24);
    }, function (_a2) {
      var _exportObj25 = {};
      _exportObj25['RepeatUntilSuccess'] = _a2['default'];

      _export(_exportObj25);
    }],
    execute: function () {}
  };
});

$__System.register('1', ['7b'], function (_export) {
  'use strict';

  var b3;
  return {
    setters: [function (_b) {
      b3 = _b;
    }],
    execute: function () {

      window.b3 = b3;
    }
  };
});

})
(function(factory) {
  factory();
});