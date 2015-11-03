'use strict';
import BaseNode from './baseNode';
import category from './category';

export default class Decorator extends BaseNode {
    constructor(child = null) {
        super();

        this.category = category.DECORATOR;
        this.child = child;
    }
};
