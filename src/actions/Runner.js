'use strict';
import Action from '../core/action';
import status from '../core/status';

export default class Runner extends Action {
    tick(tick) {
        return status.RUNNING;
    }
};
