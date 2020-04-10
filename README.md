# Via.js: use the DOM in a Web Worker (and vice versa)
Via.js lets you write JavaScript code that runs in a different context. The two main uses for this are:

- **Use the DOM in a Web Worker**: write DOM calls in a worker and have them run on the main thread
- **Write code that conveniently calls Web Worker code on the DOM**: write calls that automatically happen on a Web Worker, helping prevent heavy JavaScript calls janking the main thread. This is similar in spirit to [ComLink](https://github.com/GoogleChromeLabs/comlink), although Via.js does it differently.

Via.js currently unavoidably leaks memory since it requires [WeakRefs](https://github.com/tc39/proposal-weakrefs/) to clean up memory, and they're not currently supported by default in any browser. This means it's probably **not production-ready yet**, but should be in future when WeakRefs are supported. See the notes on memory management below.

# Examples
## Using the DOM in a Web Worker
Web Workers have a few APIs, but most web APIs are still only available in the main thread. This makes it harder to use workers when you need access to features like `document`, CSS styles, input events like `"click"`, video, WebRTC, Web Audio, etc.

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

The only difference is accessing the document object with `via.document` (`via` representing the remote global object) - **all other code is identical** to what you'd use on the DOM.

## Using Web Workers conveniently from the DOM
Via.js works the other way round too: you can write code that makes the calls on a Web Worker instead of the DOM. This provides a convenient way to have expensive JavaScript calls done off the main thread, without having to write a message-passing system.

Here is some JavaScript code that works on the DOM, but does the expensive calculation in a worker, based on the worker-calls demo:

```js
const primeCalculator = new via.PrimeCalculator();
const result = primeCalculator.IsPrime(98245166901019);
const isPrime = await get(result);
```

Note again the use of `via` to create a `PrimeCalculator` on the worker. `IsPrime()` is automatically run on the worker, even though it looks like a normal call. Finally because Via.js uses placeholder objects instead of real values, `await get()` will retrieve the actual return value from the worker. (More on how it works below.) This is all processed in a single postMessage round trip.


## Live demos
### Using the DOM in a Web Worker

A basic demo showing DOM interactions and use of the Web Audio API from a worker is hosted here: [via.js/demos/dom-in-worker](https://ashleyscirra.github.io/via.js/demos/dom-in-worker)

This works in Chrome, Firefox and Edge. Safari works but doesn't play audio since the demo only uses AudioContext, not webkitAudioContext, other than that it works fine.

### Using Web Workers conveniently from the DOM
A basic demo of controlling a Web Worker from the DOM is hosted here: [via.js/demos/worker-calls](https://ashleyscirra.github.io/via.js/demos/worker-calls)

# How it works
JavaScript's [Proxy](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Proxy) objects allow object sets, gets, calls etc. to be intercepted. Via.js uses an arrangement of Proxy objects that simply records all operations and builds a queue of commands. Function return values are also represented by a placeholder so you can continue making calls on them. This means so long as you don't need information back from the DOM (i.e. a `get()` call), you can make an arbitrary number of calls and it will only take a single postMessage to the main thread.

This approach is notable in that it doesn't post strings of JavaScript code and `eval()` them (which is a pretty ugly hack), and is also relatively low-overhead. In particular it doesn't create lots of MessageChannels like ComLink does.

Via.js commands are automatically submitted at the next microtask to be processed on the main thread, which also posts back any results to `get()` calls. (You can also force submission in long-running code with `Via.Flush()`, which returns a promise resolving when the main thread has finished executing all commands up to that point.) Via.js also handles callbacks by creating a shim that forwards the callback to the worker, as in the "click" event in the earlier example.

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

Whilst this example is straightforward, there are many details to be worked out for aspects like passing placeholder objects as function arguments, forwarding callbacks, returning values from `get()` calls, and so on. However the result is a surprisingly usable way to write code that runs somewhere else, allowing full access to remote APIs, e.g. using any part of the DOM APIs in a Web Worker.

## Memory management
The main difficulty with implementing this approach is memory management. Each Proxy representing a remote object is assigned an ID, and the remote (receiver) side keeps a map of ID to object so it can access them by the IDs in command messages. However once the controller side is done with the Proxy and it gets garbage collected, the ID map needs to be updated as well since it keeps strong references to objects, and would otherwise leak memory for unused objects.

Until recently this was impossible to achieve in JavaScript. However the [WeakRefs proposal](https://github.com/tc39/proposal-weakrefs) makes GC observable, making it possible to identify when Proxys are collected and post a cleanup message to the receiver side, which then deletes unused map entries.

At time of writing, WeakRefs are implemented behind a flag in Chrome Canary 73.0.3635.0. Via.js includes support for this to clean up memory and avoid leaking; however the spec looks set to change so this will probably stop working soon. Via.js currently uses the WeakFactory API; if it hasn't changed yet you can try it by running Canary with the command-line `chrome --js-flags="--harmony-weak-refs"`. If WeakFactory is not supported, it falls back to leaking memory! So be warned: Via.js is not production ready yet.

# API
Via.js needs you to set up a messaging bridge. In theory you could do something crazy like use a WebSocket or DataChannel bridge and run remote code over a network link! Normally you'd just wrap postMessage though. For real code see how the examples do this. However assuming you're controlling the DOM from a Worker, then the controller (worker) side does this along the lines of:

```js
Via.postMessage = (data => self.postMessage(data));
self.addEventListener("message", e => Via.OnMessage(e.data));
```

And the receiver (DOM) side does this along the lines of:

```js
worker.onmessage = (e => ViaReceiver.OnMessage(e.data));
ViaReceiver.postMessage = (data => worker.postMessage(data));
```

In other words, very straightforward, but highly customisable. For example you could adapt this to allow iframes to control each other. You could also wrap the messaging functions to tag Via.js messages a certain way, so you can still send your own separate messages without them interfering with Via.js or vice versa.

Once you have the message bridge set up, you can then just use the `via` object on the controller side as if it's the global object in the other context. For example the following creates an `AudioContext` (for the Web Audio API) in the global scope on the main thread (still assuming the DOM-in-worker setup):

```js
via.audioContext = new via.AudioContext();
```

which is equivalent to the following main thread call:

```js
window.audioContext = new window.AudioContext();
```

Then you can make further calls pretty much identically, e.g.:

```js
via.audioContext.decodeAudioData(arrayBuffer, audioBuffer =>
{
	self.audioBuffer = audioBuffer;
});
```

This posts the arguments to the DOM, performs the `decodeAudioData` call, and shims the callback to post back to the worker where your worker's callback will be invoked. This code is exactly what you'd write on the DOM, except for the use of `via.` for the global object.

## Retrieving values from the DOM

Via.js returns Proxy wrapper objects from any calls. This lets you keep making calls without having to wait for any results, and Via.js can post all the commands in one go, reducing the postMessage overhead. However it means that the return values of any calls are actually Proxy wrapper objects, even if they're a simple value like a number or boolean.

If you want to retrieve the real value from the other context, it must be accessed asynchronously, since it requires a postMessage round-trip. Via.js provides a global `get()` function which returns a promise that resolves with the requested value, e.g.:

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

# Performance
*Note: these measurements were taken prior to some significant code updates, so probably need to be updated*

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
WeakRefs need to be widely supported before this library will be useful.

Performance could still be improved. The postMessage() overhead is still relatively high. Using a binary format and transferring an ArrayBuffer, or using shared memory (SharedArrayBuffer), may be able to more or less completely eliminate this overhead. Note that if this overhead is eliminated, then building a command list on the worker can be faster than running the DOM calls (~13ms vs. ~30ms in the measurements above).

JavaScript engines could try to further optimise the code to build command lists. It looks like there is some amount of GC thrashing happening.

Some APIs must be called synchronously in callbacks, e.g. `e.preventDefault()`. Currently these don't work with Via.js, because it must do a postMessage round-trip to invoke the callback and then send back new commands, by which time the event handler has finished. Browsers need to provide a deferral mechanism to work around this, which in turn would need to be integrated in to Via.js somehow.
