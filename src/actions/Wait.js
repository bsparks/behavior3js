'use strict';
import Action from '../core/action';
import status from '../core/status';

export default class Wait extends Action {
    constructor(settings = {milliseconds: 0}) {
        super();

        this.title = 'Wait <milliseconds>ms';
        this.parameters = {'milliseconds': 0};

        this.endTime = settings.milliseconds;
    }

    open(tick) {
        var startTime = (new Date()).getTime();
        tick.blackboard.set('startTime', startTime, tick.tree.id, this.id);
    }

    tick(tick) {
        var currTime = (new Date()).getTime();
        var startTime = tick.blackboard.get('startTime', tick.tree.id, this.id);

        if (currTime - startTime > this.endTime) {
          return status.SUCCESS;
        }

        return status.RUNNING;
    }
};
