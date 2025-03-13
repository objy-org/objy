// This is for building a singular object and validating it's correctness

export default (obj, ctx) => {

	let skelleton = {
		__ctx: ctx,
		_id: obj._id,
		name: obj.name
	}

	return skelleton;
}