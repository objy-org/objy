
var Query;
(function() {
    function objectify(a) {
        var rows = [];
        for (var key in a) {
            var o = {};
            o[key] = a[key];
            rows.push(o)
        }
        return rows
    }
    if (!String.prototype.startsWith) {
        Object.defineProperty(String.prototype, "startsWith", {
            enumerable: false,
            configurable: false,
            writable: false,
            value: function(searchString, position) {
                position = position || 0;
                return this.lastIndexOf(searchString, position) === position
            }
        })
    }
    if (!String.prototype.endsWith) {
        Object.defineProperty(String.prototype, "endsWith", {
            value: function(searchString, position) {
                var subjectString = this.toString();
                if (position === undefined || position > subjectString.length) {
                    position = subjectString.length
                }
                position -= searchString.length;
                var lastIndex = subjectString.indexOf(searchString, position);
                return lastIndex !== -1 && lastIndex === position
            }
        })
    }
    Query = {
        satisfies: function(row, constraints, getter) {
            return Query.lhs._rowsatisfies(row, constraints, getter)
        },
        Query: function(constraints, getter) {
            return function(row) {
                return Query.lhs._rowsatisfies(row, constraints, getter)
            }
        },
        join: function(left_rows, right_rows, left_key, right_key) {
            var leftKeyFn, rightKeyFn;
            if (typeof left_key == "string") leftKeyFn = function(row) {
                return row[left_key]
            };
            else leftKeyFn = left_key;
            if (!right_key) rightKeyFn = leftKeyFn;
            if (typeof right_key == "string") rightKeyFn = function(row) {
                return row[left_key]
            };
            else rightKeyFn = right_key;
            return left_rows
        },
        query: function(rows, constraints, getter) {
            if (typeof getter == "string") {
                var method = getter;
                getter = function(obj, key) {
                    return obj[method](key)
                }
            }
            var filter = new Query.Query(constraints, getter);
            return rows.filter(filter)
        },
        lhs: {
            _rowsatisfies: function(row, constraints, getter) {
                for (var key in constraints) {
                    if (this[key]) {
                        if (!this[key](row, constraints[key], getter)) return false
                    } else {
                        var val = getter ? getter(row, key) : row[key];
                        var res = this.rhs._satisfies(val, constraints[key], key);
                        if (!res) return false
                    }
                }
                return true
            },
            $count: function(row, condition, getter) {
                var res = condition.$constraints.map(function(c) {
                    return Query.satisfies(row, c, getter)
                }).filter(function(v) {
                    return v
                }).length;
                return this.rhs._satisfies(res, condition.$constraint)
            },
            $not: function(row, constraint, getter) {
                return !this._rowsatisfies(row, constraint, getter)
            },
            $or: function(row, constraint, getter) {
                if (!Array.isArray(constraint)) {
                    constraint = objectify(constraint)
                }
                for (var i = 0; i < constraint.length; i++) {
                    if (this._rowsatisfies(row, constraint[i], getter)) return true
                }
                return false
            },
            $and: function(row, constraint, getter) {
                if (!Array.isArray(constraint)) {
                    constraint = objectify(constraint)
                }
                for (var i = 0; i < constraint.length; i++) {
                    if (!this._rowsatisfies(row, constraint[i], getter)) return false
                }
                return true
            },
            $nor: function(row, constraint, getter) {
                return !this.$or(row, constraint, getter)
            },
            $where: function(values, ref) {
                var fn = typeof ref == "string" ? new Function(ref) : ref;
                var res = fn.call(values);
                return res
            },
            rhs: {
                $cb: function(value, constraint, parentKey) {
                    return constraint(value)
                },
                _satisfies: function(value, constraint, parentKey) {
                    if (constraint === value) return true;
                    else if (constraint instanceof RegExp) return this.$regex(value, constraint);
                    else if (Array.isArray(constraint)) return this.$in(value, constraint);
                    else if (constraint && typeof constraint === "object") {
                        if (constraint instanceof Date) return this.$eq(value, constraint.getTime());
                        else {
                            if (constraint.$regex) return this.$regex(value, new RegExp(constraint.$regex, constraint.$options));
                            for (var key in constraint) {
                                if (!this[key]) return this.$eq(value, constraint, parentKey);
                                else if (!this[key](value, constraint[key], parentKey)) return false
                            }
                            return true
                        }
                    } else if (Array.isArray(value)) {
                        for (var i = 0; i < value.length; i++)
                            if (this.$eq(value[i], constraint)) return true;
                        return false
                    } else if (constraint === "" || constraint === null || constraint === undefined) return this.$null(value);
                    else return this.$eq(value, constraint)
                },
                $eq: function(value, constraint) {
                    if (value === constraint) return true;
                    else if (Array.isArray(value)) {
                        for (var i = 0; i < value.length; i++)
                            if (this.$eq(value[i], constraint)) return true;
                        return false
                    } else if (constraint === null || constraint === undefined || constraint === "") {
                        return this.$null(value)
                    } else if (value === null || value === "" || value === undefined) return false;
                    else if (value instanceof Date) {
                        if (constraint instanceof Date) {
                            return value.getTime() == constraint.getTime()
                        } else if (typeof constraint == "number") {
                            return value.getTime() == constraint
                        } else if (typeof constraint == "string") return value.getTime() == new Date(constraint).getTime()
                    } else {
                        return value == constraint
                    }
                },
                $exists: function(value, constraint, parentKey) {
                    return value != undefined == (constraint && true)
                },
                $deepEquals: function(value, constraint) {
                    if (typeof _ == "undefined" || typeof _.isEqual == "undefined") {
                        return JSON.stringify(value) == JSON.stringify(constraint)
                    } else {
                        return _.isEqual(value, constraint)
                    }
                },
                $not: function(values, constraint) {
                    return !this._satisfies(values, constraint)
                },
                $ne: function(values, constraint) {
                    return !this._satisfies(values, constraint)
                },
                $nor: function(values, constraint, parentKey) {
                    return !this.$or(values, constraint, parentKey)
                },
                $and: function(values, constraint, parentKey) {
                    if (!Array.isArray(constraint)) {
                        throw new Error("Logic $and takes array of constraint objects")
                    }
                    for (var i = 0; i < constraint.length; i++) {
                        var res = this._satisfies(values, constraint[i], parentKey);
                        if (!res) return false
                    }
                    return true
                },
                $or: function(values, constraint, parentKey) {
                    if (!Array.isArray(values)) {
                        values = [values]
                    }
                    for (var v = 0; v < values.length; v++) {
                        for (var i = 0; i < constraint.length; i++) {
                            if (this._satisfies(values[v], constraint[i], parentKey)) {
                                return true
                            }
                        }
                    }
                    return false
                },
                $null: function(values) {
                    var result;
                    if (values === "" || values === null || values === undefined) {
                        return true
                    } else if (Array.isArray(values)) {
                        for (var v = 0; v < values.length; v++) {
                            if (!this.$null(values[v])) {
                                return false
                            }
                        }
                        return true
                    } else return false
                },
                $in: function(values, constraint) {
                    if (!Array.isArray(constraint)) throw new Error("$in requires an array operand");
                    var result = false;
                    if (!Array.isArray(values)) {
                        values = [values]
                    }
                    for (var v = 0; v < values.length; v++) {
                        var val = values[v];
                        for (var i = 0; i < constraint.length; i++) {
                            if (this._satisfies(val, constraint[i])) {
                                result = true;
                                break
                            }
                        }
                        result = result || constraint.indexOf(val) >= 0
                    }
                    return result
                },
                $likeI: function(values, constraint) {
                    return values.toLowerCase().indexOf(constraint) >= 0
                },
                $like: function(values, constraint) {
                    return values.indexOf(constraint) >= 0
                },
                $startsWith: function(values, constraint) {
                    if (!values) return false;
                    return values.startsWith(constraint)
                },
                $endsWith: function(values, constraint) {
                    if (!values) return false;
                    return values.endsWith(constraint)
                },
                $elemMatch: function(values, constraint, parentKey) {
                    for (var i = 0; i < values.length; i++) {
                        if (Query.lhs._rowsatisfies(values[i], constraint)) return true
                    }
                    return false
                },
                $contains: function(values, constraint) {
                    return values.indexOf(constraint) >= 0
                },
                $nin: function(values, constraint) {
                    return !this.$in(values, constraint)
                },
                $regex: function(values, constraint) {
                    //constraint = new RegExp(constraint)
                    var result = false;
                    if (Array.isArray(values)) {
                        for (var i = 0; i < values.length; i++) {
                            if (constraint.test(values[i])) {
                                return true
                            }
                        }
                    } else return constraint.test(values)
                },
                $gte: function(values, ref) {
                    return !this.$null(values) && values >= this.resolve(ref)
                },
                $gt: function(values, ref) {
                    return !this.$null(values) && values > this.resolve(ref)
                },
                $lt: function(values, ref) {
                    return !this.$null(values) && values < this.resolve(ref)
                },
                $lte: function(values, ref) {
                    return !this.$null(values) && values <= this.resolve(ref)
                },
                $before: function(values, ref) {
                    if (typeof ref === "string") ref = Date.parse(ref);
                    if (typeof values === "string") values = Date.parse(values);
                    return this.$lte(values, ref)
                },
                $after: function(values, ref) {
                    if (typeof ref === "string") ref = Date.parse(ref);
                    if (typeof values === "string") values = Date.parse(values);
                    return this.$gte(values, ref)
                },
                $type: function(values, ref) {
                    return typeof values == ref
                },
                $all: function(values, ref) {
                    throw new Error("$all not implemented")
                },
                $size: function(values, ref) {
                    return typeof values == "object" && (values.length == ref || Object.keys(values).length == ref)
                },
                $mod: function(values, ref) {
                    return values % ref[0] == ref[1]
                },
                $equal: function() {
                    return this.$eq(arguments)
                },
                $between: function(values, ref) {
                    return this._satisfies(values, {
                        $gt: ref[0],
                        $lt: ref[1]
                    })
                },
                resolve: function(ref) {
                    if (typeof ref === "object") {
                        if (ref["$date"]) return Date.parse(ref["$date"])
                    }
                    return ref
                }
            }
        }
    };
    Query.undot = function(obj, key) {
      
        var keys = key.split("."),
            sub = obj;

        for (var i = 0; i < keys.length; i++) {
          
            if(sub)
                sub = sub[keys[i]]
        }
        return sub
    };
    Query.lhs.rhs.$equal = Query.lhs.rhs.$eq;
    Query.lhs.rhs.$any = Query.lhs.rhs.$or;
    Query.lhs.rhs.$all = Query.lhs.rhs.$and;
    Query.satisfies = function(row, constraints, getter) {
        return this.lhs._rowsatisfies(row, constraints, getter)
    };
    Array.prototype.query = function(q) {
        return Query.query(this, q)
    };
    RegExp.prototype.toJSON = RegExp.prototype.toString;
    if (typeof module != "undefined") module.exports = Query;
    else if (typeof define != "undefined" && define.amd) define("query", [], function() {
        return Query
    });
    else if (typeof window != "undefined") window.Query = Query;
    else if (typeof GLOBAL != undefined && GLOBAL.global) GLOBAL.global.Query = Query;
    return Query
})(this);

module.exports = Query;