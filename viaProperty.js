"use strict";

{
	const ViaPropertyHandler =
	{
		get(target, property, receiver)
		{
			// Return another Via property proxy with an extra property in its path,
			// unless the special target symbol is passed, in which case return the actual target.
			if (property === Via.__TargetSymbol)
				return target;
			
			return Via._MakeProperty(target._objectId, [...target._path, property]);
		},
		
		set(target, property, value, receiver)
		{
			// Add a set command to the queue, including a copy of the property path.
			const path = target._path.slice(0);
			path.push(property);
			
			Via._AddToQueue([1 /* set */, target._objectId, path, Via._WrapArg(value)]);
			
			return true;
		},
		
		apply(target, thisArg, argumentsList)
		{
			// Allocate a new object ID for the return value, add a call command to the queue, and then return
			// a Via object proxy representing the returned object ID.
			const returnObjectId = Via._GetNextObjectId();
			
			Via._AddToQueue([0 /* call */, target._objectId, target._path, argumentsList.map(Via._WrapArg), returnObjectId]);
			
			return Via._MakeObject(returnObjectId);
		},
		
		construct(target, argumentsList, newTarget)
		{
			// This is the same as the apply trap except a different command is used for construct instead of call.
			// The command handler is also the same as when calling a function, except it uses 'new'.
			const returnObjectId = Via._GetNextObjectId();
			
			Via._AddToQueue([4 /* construct */, target._objectId, target._path, argumentsList.map(Via._WrapArg), returnObjectId]);
			
			return Via._MakeObject(returnObjectId);
		}
	};

	Via._MakeProperty = function (objectId, path)
	{
		// For the apply and construct traps to work, the target must be callable.
		// So use a function object as the target, and stash the object ID and
		// the property path on it.
		const func = function () {};
		func._objectId = objectId;
		func._path = path;
		return new Proxy(func, ViaPropertyHandler);
	}
}