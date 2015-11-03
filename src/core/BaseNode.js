'use strict';

import uuid from 'node-uuid';
import STATUS from './status';

export default class BaseNode {
    constructor() {
        this.id = uuid();
        this.title = '';
        this.description = '';
        this.parameters = {};
        this.properties = {};
    }

    _execute(tick) {
        // ENTER
        this._enter(tick);

        // OPEN
        if (!tick.blackboard.get('isOpen', tick.tree.id, this.id)) {
            this._open(tick);
        }

        // TICK
        var status = this._tick(tick);

        // CLOSE
        if (status !== STATUS.RUNNING) {
            this._close(tick);
        }

        // EXIT
        this._exit(tick);

        return status;
    }

    _enter(tick) {
        tick._enterNode(this);
        this.enter(tick);
    }

    _open(tick) {
        tick._openNode(this);
        tick.blackboard.set('isOpen', true, tick.tree.id, this.id);
        this.open(tick);
    }

    _tick(tick) {
        tick._tickNode(this);
        return this.tick(tick);
    }

    _close(tick) {
        tick._closeNode(this);
        tick.blackboard.set('isOpen', false, tick.tree.id, this.id);
        this.close(tick);
    }

    _exit(tick) {
        tick._exitNode(this);
        this.exit(tick);
    }

    enter(tick) {
        // subclass implements
    }

    open(tick) {
        // subclass implements
    }

    tick(tick) {
        // subclass implements
    }

    close(tick) {
        // subclass implements
    }

    exit(tick) {
        // subclass implements
    }
};
