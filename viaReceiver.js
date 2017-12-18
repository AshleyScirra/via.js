"use strict";

{
	// Namespace
	self.Via = {};
	
	// The master map of object ID to the real object. Object ID 0 is always the global object on
	// the main thread (i.e. window or self).
	// TODO: find a way to store this without leaking every object that ever gets assigned an ID!
	// Keeping objects in the map will prevent them being collected. We need something like a WeakMap
	// that has weak values instead of keys, but that would make GC observable so doesn't exist in JS.
	const idMap = new Map([[0, self]]);
	
	// Map objects back to their real ID, so we can recycle IDs. This isn't particularly effective
	// since the worker will keep creating new IDs for any re-used objects/properties, since
	// it can't prove if they'll return the same value or not, but it's worth trying.
	const reverseMap = new Map([[self, 0]]);
	
	// Some objects are allocated an ID here on the main thread, when running a callback with
	// a not-yet-seen object as a parameter. To avoid ID collisions with the worker, main thread
	// object IDs are negative and decrement and worker object IDs are positive and increment.
	let nextObjectId = -1;
	
	// Get the real object from an ID.
	function IdToObject(id)
	{
		const ret = idMap.get(id);
		
		if (typeof ret === "undefined")
			throw new Error("missing object id: " + id);
		
		return ret;
	}
	
	// Get the existing ID from an object if any, allowing IDs to be recycled.
	// Otherwise allocate a new ID for this object.
	function ObjectToId(object)
	{
		let id = reverseMap.get(object);
		
		if (typeof id === "undefined")
		{
			// Allocate new ID. The main thread uses negative IDs to prevent collisions with the worker.
			id = nextObjectId--;
			idMap.set(id, object);
			reverseMap.set(object, id);
			return id;
		}
		
		return id;
	}
	
	// Add a new object to the ID map. This is used when the worker tells us what it has assigned for
	// a new object ID returned by a call or construct command. Note there's no point trying to re-use
	// IDs here: the worker has already gone ahead and used this object ID to refer to this object, so
	// we have to permanently map it.
	function AddToIdMap(object, id)
	{
		idMap.set(id, object);
		reverseMap.set(object, id);
	}
	
	// Get the real value from an ID and a property path, e.g. object ID 0, path ["document", "title"]
	// will return window.document.title.
	function IdToObjectProperty(id, path)
	{
		const ret = idMap.get(id);
		
		if (typeof ret === "undefined")
			throw new Error("missing object id: " + id);
		
		let base = ret;
		
		for (let i = 0, len = path.length; i < len; ++i)
			base = base[path[i]];
		
		return base;
	}
	
	function CanStructuredClone(o)
	{
		const type = typeof o;
		return type === "undefined" || o === null || type === "boolean" || type === "number" || type === "string" ||
				(o instanceof Blob) || (o instanceof ArrayBuffer) || (o instanceof ImageData);
	}
	
	// Wrap an argument. This is used for sending values back to the worker. Anything that can be directly
	// posted is sent as-is, but any kind of object is represented by its object ID instead.
	function WrapArg(arg)
	{
		if (CanStructuredClone(arg))
		{
			return [0 /* primitive */, arg];
		}
		else
		{
			return [1 /* object */, ObjectToId(arg)];
		}
	}
	
	// Get a shim function for a given callback ID. This creates a new function that forwards the
	// call with its arguments to the worker, where it will run the real callback.
	// Callback functions are not re-used even if their ID is used repeatedly, since storing them
	// in a map prevents them ever being collected.
	function GetCallbackShim(id)
	{
		return ((...args) => Via.postMessage({
			"type": "callback",
			"id": id,
			"args": args.map(WrapArg)
		}));
	}
	
	// Unwrap an argument sent from the worker. Arguments are transported as small arrays indicating
	// the type and any object IDs/property paths, so they can be looked up on the main thread.
	function UnwrapArg(arr)
	{
		switch (arr[0])	{
		case 0:		// primitive
			return arr[1];
		case 1:		// object
			return IdToObject(arr[1]);
		case 2:		// callback
			return GetCallbackShim(arr[1]);
		case 3:		// object property
			return IdToObjectProperty(arr[1], arr[2]);
		default:
			throw new Error("invalid arg type");
		}
	}
	
	// Called when receiving a message from the worker.
	Via.OnMessage = function (data)
	{
		const getResults = [];		// list of values requested to pass back to worker
		
		// Run all sent commands
		for (const cmd of data.cmds)
		{
			RunCommand(cmd, getResults);
		}
		
		// Post back that we're done (so the flush promise resolves), and pass along any get values.
		Via.postMessage({
			"type": "done",
			"flushId": data.flushId,
			"getResults": getResults
		});
	}
	
	function RunCommand(arr, getResults)
	{
		const type = arr[0];
		
		switch (type) {
		case 0:		// call
			ViaCall(arr[1], arr[2], arr[3], arr[4]);
			break;
		case 1:		// set
			ViaSet(arr[1], arr[2], arr[3]);
			break;
		case 2:		// get
			ViaGet(arr[1], arr[2], arr[3], getResults);
			break;
		case 3:		// reset
			ViaResetReferences();
			break;
		case 4:		// constructor
			ViaConstruct(arr[1], arr[2], arr[3], arr[4]);
			break;
		default:
			throw new Error("invalid cmd type: " + type);
		}
	}
	
	function ViaCall(objectId, path, argsData, returnObjectId)
	{
		const obj = IdToObject(objectId);
		const args = argsData.map(UnwrapArg);
		const methodName = path[path.length - 1];
		
		let base = obj;
		
		for (let i = 0, len = path.length - 1; i < len; ++i)
		{
			base = base[path[i]];
		}
		
		const ret = base[methodName](...args);
		AddToIdMap(ret, returnObjectId);
	}
	
	function ViaConstruct(objectId, path, argsData, returnObjectId)
	{
		const obj = IdToObject(objectId);
		const args = argsData.map(UnwrapArg);
		const methodName = path[path.length - 1];
		
		let base = obj;
		
		for (let i = 0, len = path.length - 1; i < len; ++i)
		{
			base = base[path[i]];
		}
		
		const ret = new base[methodName](...args);
		AddToIdMap(ret, returnObjectId);
	}
	
	function ViaSet(objectId, path, valueData)
	{
		const obj = IdToObject(objectId);
		const value = UnwrapArg(valueData);
		const propertyName = path[path.length - 1];
		
		let base = obj;
		
		for (let i = 0, len = path.length - 1; i < len; ++i)
		{
			base = base[path[i]];
		}
		
		base[propertyName] = value;
	}
	
	function ViaGet(getId, objectId, path, getResults)
	{
		const obj = IdToObject(objectId);
		
		if (path === null)
		{
			getResults.push([getId, WrapArg(obj)]);
			return;
		}
		
		const propertyName = path[path.length - 1];
		
		let base = obj;
		
		for (let i = 0, len = path.length - 1; i < len; ++i)
		{
			base = base[path[i]];
		}
		
		const value = base[propertyName];
		getResults.push([getId, WrapArg(value)]);
	}
	
	function ViaResetReferences()
	{
		idMap.clear();
		reverseMap.clear();
		idMap.set(0, self);
		reverseMap.set(self, 0);
	}
}