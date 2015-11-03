'use strict';
import status from '../status';
import Decorator from '../core/decorator';

export default class Repeater extends Decorator {
    constructor(params = {maxLoop: -1}) {
        super();

        this.title = 'Repeat <maxLoop>x';
        this.parameters = {maxLoop: -1};

        this.maxLoop = params.maxLoop;
    }

    open(tick) {
        tick.blackboard.set('loopCount', 0, tick.tree.id, this.id);
    }

    tick(tick) {
        if (!this.child) {
            return status.ERROR;
        }

        var loopCount = tick.blackboard.get('loopCount', tick.tree.id, this.id);
        var childStatus = status.SUCCESS;

        while (this.maxLoop < 0 || loopCount < this.maxLoop) {
            childStatus = this.child._execute(tick);

            if (childStatus === status.SUCCESS || childStatus === status.FAILURE) {
                loopCount++;
            } else {
                break;
            }
        }

        loopCount = tick.blackboard.set('loopCount', loopCount, tick.tree.id, this.id);
        return childStatus;
    }
};
