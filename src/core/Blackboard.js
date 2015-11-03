'use strict';

var baseMemory = new WeakMap();
var treeMemory = new WeakMap();

export default class Blackboard {
    constructor() {
        baseMemory.set(this, new Map());
        treeMemory.set(this, new Map());
    }

    _getTreeMemory(treeScope) {
        let memory = treeMemory.get(this);

        if (!memory.has(treeScope)) {
            let treeMem = new Map();
            treeMem.set('nodeMemory', new Map());
            treeMem.set('openNodes', []);
            treeMem.set('traversalDepth', 0);
            treeMem.set('traversalCycle', 0);

            memory.set(treeScope, treeMem);
        }

        return memory.get(treeScope);
    }

    _getNodeMemory(treeMemory, nodeScope) {
        var memory = treeMemory.get('nodeMemory');

        if (!memory.has(nodeScope)) {
            memory.set(nodeScope, new Map());
        }

        return memory.get(nodeScope);
    }

    _getMemory(treeScope, nodeScope) {
        var memory = baseMemory.get(this);

        if (treeScope) {
            memory = this._getTreeMemory(treeScope);

            if (nodeScope) {
                memory = this._getNodeMemory(memory, nodeScope);
            }
        }

        return memory;
    }

    set(key, value, treeScope, nodeScope) {
        var memory = this._getMemory(treeScope, nodeScope);

        memory.set(key, value);
    }

    get(key, treeScope, nodeScope) {
        var memory = this._getMemory(treeScope, nodeScope);

        return memory.get(key);
    }
};
