'use strict';
import status from '../status';
import Decorator from '../core/decorator';

export default class Inverter extends Decorator {
    tick(tick) {
        if (!this.child) {
            return status.ERROR;
        }

        var childStatus = this.child._execute(tick);

        if(childStatus === status.SUCCESS) {
            childStatus = status.FAILURE;
        } else if (childStatus === status.FAILURE) {
            childStatus = status.SUCCESS;
        }

        return childStatus;
    }
};
