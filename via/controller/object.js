"use strict";

{
	if (!self.Via)
		self.Via = {};
	
	const ViaObjectHandler =
	{
		get(target, property, receiver)
		{
			// Return a Via property proxy, unless the special object symbol is passed,
			// in which case return the backing object ID.
			if (property === Via.__ObjectSymbol)
				return target._objectId;
			
			return Via._MakeProperty(target._objectId, [property]);
		},
		
		set(target, property, value, receiver)
		{
			// Add a set command to the queue.
			Via._AddToQueue([1 /* set */, target._objectId, [property], Via._WrapArg(value)]);
			
			return true;
		}
	};

	Via._MakeObject = function (id)
	{
		// For the apply and construct traps to work, the target must be callable.
		// So use a function object as the target, and stash the object ID on it.
		const func = function() {};
		func._objectId = id;
		const ret = new Proxy(func, ViaObjectHandler);

		// When supported, register the returned object in the finalization registry with
		// its associated ID. This allows GC of the Proxy object to notify the receiver
		// side that its ID can be dropped, ensuring the real object can be collected
		// as well. If this is not supported it will leak memory!
		if (Via.finalizationRegistry)
			Via.finalizationRegistry.register(ret, id);
		
		return ret;
	}
}