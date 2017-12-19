# Via.js: use the DOM in a Web Worker
Web Workers have a few APIs, but most web APIs are still only available in the main thread. This makes it harder to use workers when you need access to features like `document`, CSS styles, input events like `"click"`, WebRTC, Web Audio, etc. Via.js is an experimental library that uses an arrangement of Proxy objects to **automatically forward calls from a Worker to the main thread**, as well as returning values and forwarding callbacks.

Via.js is not ready for production use; it's more of a proof-of-concept. See below for caveats.

## Live demo

A basic demo showing DOM interactions and use of the Web Audio API from a worker is hosted here: [https://ashleyscirra.github.io/via.js/](https://ashleyscirra.github.io/via.js/)

This works in Chrome, Firefox and Edge. Safari works but doesn't play audio since the demo only uses AudioContext, not webkitAudioContext, other than that it works fine.

## Example

Here are some DOM calls **that work in a Web Worker** using Via.js:

```js
const document = via.document;
const button = document.createElement("button");
button.textContent = "Click me";
button.style.fontWeight = "bold";
button.addEventListener("click", () =>
{
	console.log("[Worker] Click event");
});
document.body.appendChild(button);
```

The *only difference* API-wise is the use of `via.document` instead of `document` directly. The intent is that the global `via` object in the worker represents the global object on the main thread (i.e. `window`). For example the following creates an `AudioContext` (for the Web Audio API) in the global scope on the main thread:

```js
via.audioContext = new via.AudioContext();
```

which is equivalent to the following main thread calls:

```js
window.audioContext = new window.AudioContext();
```

## Retrieving values from the DOM

If you want to retrieve a value from the DOM, it must be accessed asynchronously, since it requires a postMessage round-trip. Via.js provides a global `get()` function which returns a promise that resolves with the requested DOM property value, e.g.:

```js
const docTitle = await get(via.document.title);
```

You can look up multiple values in parallel, which is more efficient than waiting for each property one at a time, e.g.:

```js
const [docTitle, docUrl] = await Promise.all([
	get(via.document.title),
	get(via.document.URL)
]);
```

This processes both gets with a single postMessage round-trip.

# How it works
JavaScript's Proxy objects allow object sets, gets, calls etc. to be intercepted. Via.js uses an arrangement of Proxy objects that simply records all operations and builds a queue of commands. Function return values are also represented by a placeholder so you can continue making calls on them. This means so long as you don't need information back from the DOM (i.e. a `get()` call), you can make an arbitrary number of calls and it will only take a single postMessage to the main thread.

The commands are automatically submitted at the next microtask to be processed on the main thread, which also posts back any results to `get()` calls. (You can also force submission in long-running code with `Via.Flush()`, which returns a promise resolving when the main thread has finished executing all commands up to that point.) Via.js also handles callbacks by creating a shim that forwards the callback to the worker, as in the "click" event in the earlier example.

For example consider the following lines:
```js
const div = via.document.createElement("div");
div.textContent = "Hello world";
```
Via.js builds a command queue roughly similar to:
```
1. call window.document.createElement with argument "div"
2. return a placeholder object with id 1
3. assign object id 1 property "textContent" value "Hello world"
```
At the next microtask these commands are submitted to the main thread via postMessage(), and they are carried out with real DOM calls.

Whilst this example is straightforward, there are many details to be worked out for aspects like passing placeholder objects as function arguments, forwarding callbacks, returning values from `get()` calls, and so on. However the result is a surprisingly usable DOM API in a worker.

# The big problem: leaking memory
The main reason you wouldn't want to use Via.js is because currently every single DOM object you use from the worker is permanently leaked! This is because Via.js must maintain maps of object ID to the real object, so when it receives a command involving object ID 1 it knows how to find it. It's impossible to know how long the worker will hold on to these references because garbage collection is not observable in JavaScript. So the library has no way of ever removing objects from its ID map. Any time an object would normally be garbage collected, it will have one last reference in the ID map which will prevent it being collected.

The JavaScript [WeakRefs proposal](https://github.com/tc39/proposal-weakrefs/blob/master/specs/weakrefs.md) could solve this, since then it could map an ID to a weak reference, ensuring the value can be collected if it is the last reference. The WeakRef executor can then also remove the entry from the map.

# Performance
Here are some measurements providing a rough guide of the performance ballpark, comparing creating 1000 div elements with randomised contents both directly in the DOM and with Via.js in a worker. The test code is as follows:

```js
const lorem_ipsum = ...;
const body = document.body;

for (let i = 0; i < 1000; ++i)
{
	const div = document.createElement("div");
	div.textContent = lorem_ipsum.substr(Math.floor(Math.random() * lorem_ipsum.length / 2));
	const style = div.style;
	style.border = "1px solid blue";
	style.padding = "1em";
	body.appendChild(div);
}
```

The following measurements were made on a HTC 10 (Android 7.0) with Chrome Dev 64. The test loop function was run 10 times and the first 3 results ignored as warmup runs. The results have quite a lot of variance due to garbage collection running during the test.

### Directly on DOM
Running DOM calls: ~30-40ms

### Using Via.js in a worker
- (Worker) Building command list: ~3-20ms
- (Worker) Submitting commands (postMessage): ~10ms
- (MainThread) Executing commands: ~60ms

It appears building the command list is mostly bottlenecked on GC. The results have high variance, but in the best case, run amazingly quickly. Unlike real DOM calls building commands doesn't actually do any real work, so it makes sense it can be faster. Therefore it seems Via.js is not terribly slow; a good approximation is it takes about as long as the direct DOM calls do on both ends (worker and main thread).

This may not seem like much benefit overall, but there is one major difference. In both cases the browser then went on to do **~250ms of layout** for the 1000 added elements. If all your code is on the main thread, the 250ms of layout is synchronous and will suspend all other JavaScript execution on the main thread. However if you make calls from the worker, **it carries on running JavaScript while the browser does layout**. That gives you another 250ms of execution time in the worker that you wouldn't have had on the main thread, and in this case it more than makes up for the overhead of Via.js.

However if you spend that extra 250ms making more DOM calls from the worker, they will simply be queued up and will have to wait until layout finishes before they are run. In other words, DOM throughput isn't improved. Alternatively if you have other JavaScript-intensive code to run that doesn't involve DOM calls, then this is great - you get another 250ms to do useful work.

In summary, it seems the overhead of Via.js isn't huge, and providing you have lots of non-DOM JavaScript code to run, being able to run it in parallel to layout is a huge advantage. In other cases, such as making a handful of calls to use the Web Audio API, the performance overhead probably isn't significant while providing a great convenience.

# Further work
The biggest problem to solve is the memory leak. WeakRefs may be able to solve this, in which case Via.js could be useful for real-world projects.

Performance could still be improved. The postMessage() overhead is still relatively high. Using a binary format and transferring an ArrayBuffer, or using shared memory (SharedArrayBuffer), may be able to more or less completely eliminate this overhead. Note that if this overhead is eliminated, then building a command list on the worker is actually faster than running the DOM calls (~50ms vs. ~60ms in the measurements above).

JavaScript engines could try to further optimise the code to build command lists. It looks like there is some amount of GC thrashing happening.

Browsers themselves could potentially use a similar approach to provide built-in support for DOM APIs in workers. If it's integrated to the browser it could handle memory management automatically (avoiding a memory leak) and better optimise command list building and execution to further reduce the overhead. This library demonstrates that the concept can work reasonably well.

Several browser APIs only work in a user input event, such as audio playback can only be started in a "touchend" event on iOS. This simply does not work with Web Workers, since they work asynchronously, so by the time you try to play audio it is no longer in the "touchend" event so the attempt is blocked. Browsers must fundamentally re-think the way user-gesture limited APIs work to fix this.