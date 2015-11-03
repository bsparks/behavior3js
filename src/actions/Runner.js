'use strict';
import Action from '../core/action';
import status from '../status';

export default class Runner extends Action {
    tick(tick) {
        return status.RUNNING;
    }
};
