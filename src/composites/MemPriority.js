'use strict';
import status from '../status';
import Composite from '../core/composite';

export default class MemPriority extends Composite {
    open(tick) {
        tick.blackboard.set('runningChild', 0, tick.tree.id, this.id);
    }

    tick(tick) {
        var runningChild = tick.blackboard.get('runningChild', tick.tree.id, this.id);

        for (let i = runningChild, len = this.children.length; i < len; i++) {
            var childStatus = this.children[i]._execute(tick);

            if (childStatus !== status.FAILURE) {
                if (childStatus === status.RUNNING) {
                    tick.blackboard.set('runningChild', i, tick.tree.id, this.id);
                }
                return childStatus;
            }
        }

        return status.FAILURE;
    }
};
