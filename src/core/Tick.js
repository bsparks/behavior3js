'use strict';

export default class Tick {
    constructor() {
        // set by BehaviorTree
        this.tree       = null;
        this.debug      = null;
        this.target     = null;
        this.blackboard = null;

        // updated during the tick signal
        this._openNodes  = [];
        this._nodeCount  = 0;
    }

    _enterNode(node) {
        this._nodeCount++;
        this._openNodes.push(node);
    }

    _openNode(node) {

    }

    _tickNode(node) {

    }

    _closeNode(node) {
        this._openNodes.pop();
    }

    _exitNode(node) {

    }
};
