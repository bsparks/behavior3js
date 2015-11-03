'use strict';

import uuid from 'node-uuid';
import Blackboard from './blackboard';
import Tick from './tick';

export default class BehaviorTree {
    constructor() {
        this.id = uuid();
        this.title = 'The behavior tree';
        this.description = 'Default description';
        this.properties = {};
        this.root = null;
        this.debug = null;
    }

    tick(target, blackboard) {
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
        for (let i = 0; i < len; i++) {
            start = i + 1;
            if (lastOpenNodes[i] !== currOpenNodes[i]) {
                break;
            }
        }

        for (let i = lastOpenNodes.length - 1; i >= start; i--) {
            lastOpenNodes[i]._close(tick);
        }

        blackboard.set('openNodes', currOpenNodes, this.id);
        blackboard.set('nodeCount', tick._nodeCount, this.id);

        return state;
    }
};
