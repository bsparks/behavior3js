'use strict';
import status from '../core/status';
import Decorator from '../core/decorator';

export default class Limiter extends Decorator {
    constructor(params = {maxLoop: 1}) {
        super();

        this.title = 'Limit <maxLoop> Activations';
        this.parameters = {
            maxLoop: 1
        };

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

        if (loopCount < this.maxLoop) {
            var childStatus = this.child._execute(tick);

            if (childStatus === status.SUCCESS || childStatus === status.FAILURE) {
                tick.blackboard.set('loopCount', loopCount + 1, tick.tree.id, this.id);
            }

            return childStatus;
        }

        return status.FAILURE;
    }
}
