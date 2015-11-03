'use strict';
import status from '../core/status';
import Decorator from '../core/decorator';

export default class RepeatUntilSuccess extends Decorator {
    constructor(maxLoop = -1) {
        super();

        this.title = 'Repeat Until Success';
        this.parameters = {maxLoop: -1};

        this.maxLoop = maxLoop;
    }

    open(tick) {
        tick.blackboard.set('loopCount', 0, tick.tree.id, this.id);
    }

    tick(tick) {
        if (!this.child) {
            return status.ERROR;
        }

        var loopCount = tick.blackboard.get('loopCount', tick.tree.id, this.id);
        var childStatus = status.ERROR;

        while (this.maxLoop < 0 || loopCount < this.maxLoop) {
            childStatus = this.child._execute(tick);

            if (childStatus === status.FAILURE) {
                loopCount++;
            } else {
                break;
            }
        }

        loopCount = tick.blackboard.set('loopCount', loopCount, tick.tree.id, this.id);
        return childStatus;
    }
};
