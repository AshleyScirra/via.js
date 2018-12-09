"use strict";

self.addEventListener("message", e =>
{
	if (e.data === "start")
	{
		importScripts("../../via/controller/object.js",
					  "../../via/controller/property.js",
					  "../../via/controller/controller.js");
		
		Via.postMessage = (data => self.postMessage(data));
		Start();
	}
	else
	{
		Via.OnMessage(e.data);
	}
});

async function Start()
{
	const document = via.document;
	
	// Demo of retrieving DOM property values
	const [docTitle, docUrl] = await Promise.all([
		get(document.title),
		get(document.URL)
	]);
	
	console.log("Document title is: " + docTitle + ", URL is: " + docUrl);
	
	const h1 = document.createElement("h1");
	h1.textContent = "Via.js - using DOM in worker";
	document.body.appendChild(h1);
	
	const p = document.createElement("p");
	p.textContent = "This page's contents and logic, including this text, was created by a Web Worker using APIs almost identical to the usual DOM APIs. In this case the controller is the worker, and the receiver is the DOM. To demonstrate the flexibility of the approach, the button below uses the Web Audio API to load and play a sound effect when clicked. The entire process, from creating the button, attaching an event handler, running the callback, creating an AudioContext, decoding the audio, creating audio buffers and nodes, and starting playback of the sound, is controlled entirely by the worker.";
	document.body.appendChild(p);
	
	const button = document.createElement("button");
	button.textContent = "Click me";
	button.style.fontWeight = "bold";
	button.addEventListener("click", OnClick);
	document.body.appendChild(button);
	
	via.audioContext = new via.AudioContext();
	
	const response = await fetch("sfx5.m4a");
	const arrayBuffer = await response.arrayBuffer();
	
	via.audioContext.decodeAudioData(arrayBuffer, audioBuffer =>
	{
		self.audioBuffer = audioBuffer;
	});
}

async function OnClick(e)
{
	const [x, y] = await Promise.all([
		get(e.clientX),
		get(e.clientY)
	]);
	
	console.log("[Worker] Click event at " + x + ", " + y);
	
	const source = via.audioContext.createBufferSource();
	source.buffer = self.audioBuffer;
	source.connect(via.audioContext.destination);
	source.start(0);
}