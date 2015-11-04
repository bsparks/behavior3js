'use strict';
import STATUS from '../core/status';
import Composite from '../core/composite';

export default class Parallel extends Composite {
    constructor(successThreshold = 0, failureThreshold = 0) {
        super();

        this.successThreshold = successThreshold;
        this.failureThreshold = failureThreshold;
    }

    tick(tick) {
        var counter = {};
        counter[STATUS.SUCCESS] = 0;
        counter[STATUS.FAILURE] = 0;
        counter[STATUS.RUNNING] = 0;
        counter[STATUS.ERROR] = 0;

        this.children.forEach(function(node) {
            counter[node._execute(tick)]++;
        });

        if (counter[STATUS.SUCCESS] >= this.successThreshold) {
            return STATUS.SUCCESS;
        } else if (counter[STATUS.FAILURE] >= this.failureThreshold) {
            return STATUS.FAILURE;
        }

        return STATUS.RUNNING;
    }
}
