"use strict";

{
	// Namespace for receiver side (which receives calls from the controller side)
	self.ViaReceiver = {};
	
	// The master map of object ID to the real object. Object ID 0 is always the global object on
	// the receiver (i.e. window or self). IDs are removed by cleanup messages, which are sent
	// by the controller when the Proxy with that ID is garbage collected (which requires WeakCell
	// support), indicating it cannot be used any more. This is important to avoid a memory leak,
	// since if the IDs are left behind they will prevent the associated object being collected.
	const idMap = new Map([[0, self]]);
	
	// Some objects are allocated an ID here on the receiver side, when running callbacks with
	// object parameters. To avoid ID collisions with the controller, receiver object IDs are
	// negative and decrement, and controller object IDs are positive and increment.
	let nextObjectId = -1;
	
	// Get the real object from an ID.
	function IdToObject(id)
	{
		const ret = idMap.get(id);
		
		if (typeof ret === "undefined")
			throw new Error("missing object id: " + id);
		
		return ret;
	}
	
	// Allocate new ID for an object on the receiver side.
	// The receiver uses negative IDs to prevent ID collisions with the controller.
	function ObjectToId(object)
	{
		const id = nextObjectId--;
		idMap.set(id, object);
		return id;
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
	
	// Wrap an argument. This is used for sending values back to the controller. Anything that can be directly
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
	// call with its arguments to the controller, where it will run the real callback.
	// Callback functions are not re-used to allow them to be garbage collected normally.
	function GetCallbackShim(id)
	{
		return ((...args) => ViaReceiver.postMessage({
			"type": "callback",
			"id": id,
			"args": args.map(WrapArg)
		}));
	}
	
	// Unwrap an argument sent from the controller. Arguments are transported as small arrays indicating
	// the type and any object IDs/property paths, so they can be looked up on the receiver side.
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
	
	// Called when receiving a message from the controller.
	ViaReceiver.OnMessage = function (data)
	{
		switch (data.type) {
		case "cmds":
			OnCommandsMessage(data);
			break;
		case "cleanup":
			OnCleanupMessage(data);
			break;
		default:
			console.error("Unknown message type: " + data.type);
			break;
		}
	};

	function OnCommandsMessage(data)
	{
		const getResults = [];		// list of values requested to pass back to controller
		
		// Run all sent commands
		for (const cmd of data.cmds)
		{
			RunCommand(cmd, getResults);
		}
		
		// Post back that we're done (so the flush promise resolves), and pass along any get values.
		ViaReceiver.postMessage({
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
		case 3:		// constructor
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
		idMap.set(returnObjectId, ret);
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
		idMap.set(returnObjectId, ret);
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

	function OnCleanupMessage(data)
	{
		// Delete a list of IDs sent from the controller from the ID map. This happens when
		// the Proxys on the controller side with these IDs are garbage collected, so the IDs
		// on the receiver can be dropped ensuring the associated objects can be collected.
		for (const id of data.ids)
			idMap.delete(id);
	}
}