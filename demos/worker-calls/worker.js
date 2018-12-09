"use strict";

self.addEventListener("message", e =>
{
	if (e.data === "start")
	{
		importScripts("../../via/receiver/receiver.js");
		
		ViaReceiver.postMessage = (data => self.postMessage(data));
	}
	else
	{
		ViaReceiver.OnMessage(e.data);
	}
});

// Prime calculator class called from DOM side. Note it must be available on
// the global object for Via to be able to find it. Otherwise it's written
// just like a normal class with nothing special about it.
self.PrimeCalculator = class {
	constructor()
	{
		// Cache of number -> is prime. This is basically to demonstrate a stateful
		// object held on the worker side; otherwise IsPrime is just a normal function.
		this._cache = new Map();
	}

	IsPrime(n)
	{
		// Return cached result if possible
		if (this._cache.has(n))
			return this._cache.get(n);
		
		// Otherwise calculate now if it's prime using a naive check which should
		// be slow enough to take some time for large numbers, demonstrating the benefit
		// of using a worker for this task.
		let isPrime = true;

		const lim = Math.sqrt(n);
		for (let f = 2; f <= lim; ++f)
		{
			if (n % f === 0)
			{
				isPrime = false;
				break;
			}
		}

		this._cache.set(n, isPrime);
		return isPrime;
	}
}