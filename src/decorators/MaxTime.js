'use strict';
import status from '../status';
import Decorator from '../core/decorator';

export default class MaxTime extends Decorator {
    constructor(params = {maxTime: 0}) {
        super();

        this.title = 'Max <maxTime>ms';
        this.parameters = {maxTime: 0};

        this.maxTime = params.maxTime;
    }

    open(tick) {
        var startTime = (new Date()).getTime();
        tick.blackboard.set('startTime', startTime, tick.tree.id, this.id);
    }

    tick(tick) {
        if (!this.child) {
            return status.ERROR;
        }

        var currTime = (new Date()).getTime();
        var startTime = tick.blackboard.get('startTime', tick.tree.id, this.id);

        var childStatus = this.child._execute(tick);
        if (currTime - startTime > this.maxTime) {
            return status.FAILURE;
        }

        return childStatus;
    }
};
