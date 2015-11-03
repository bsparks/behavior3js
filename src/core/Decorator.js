'use strict';
import BaseNode from './baseNode';
import category from './category';

export default class Decorator extends BaseNode {
    constructor(params = {child: null}) {
        super();

        this.category = category.DECORATOR;
        this.child = params.child;
    }
};
