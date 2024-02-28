import { action } from "./actions.js";
import { loadBinaryResource } from "./utility.js";
import Module from "./main.js";

// WASM Module
let module;

// hard-coded filepath for loaded model in vfs
const model_file_path = "/models/model.bin";

// Function to send model line result
const print = (text) => {
  postMessage({
    event: action.WRITE_RESULT,
    text: text,
  });
};

// Function to initialize worker
// and download model file
const decoder = new TextDecoder("utf-8");
const punctuationBytes = [
  33, 34, 35, 36, 37, 38, 39, 40, 41, 42, 43, 44, 45, 46, 47, 58, 59, 60, 61, 62, 63, 64, 91, 92, 93, 94, 95, 96, 123,
  124, 125, 126,
];
const whitespaceBytes = [32, 9, 10, 13, 11, 12];
const splitBytes = [...punctuationBytes, ...whitespaceBytes];
const stdoutBuffer = [];

const stdin = () => {};

const stdout = (c) => {
  stdoutBuffer.push(c);

  if (splitBytes.indexOf(c) == -1) {
    return;
  }

  const text = decoder.decode(new Uint8Array(stdoutBuffer));
  stdoutBuffer.splice(0, stdoutBuffer.length);
  print(text);
};

const stderr = () => {};

// This function is designed to create a fetch-compatible stream that writes data to an Emscripten FS file.
async function writeToEmscriptenFS(url, emscriptenFS, filePath) {
  // Fetch the resource
  const response = await fetch(url);

  // Ensure the response is valid and we have a body to work with
  if (!response.body) {
    throw Error("Failed to get the stream from the response");
  }

  // Get a reader for the response stream
  const reader = response.body.getReader();

  // Ensure the specified path's directory exists and open the file
  emscriptenFS.createPath("/", filePath.substring(0, filePath.lastIndexOf("/")), true, true);
  const file = emscriptenFS.open(filePath, "w+");

  async function pump() {
    const { done, value } = await reader.read();

    // When no more data needs to be consumed, close the stream and the file
    if (done) {
      emscriptenFS.close(file);
      console.log("Stream finished. File written to Emscripten FS.");
      return;
    }

    // Write the chunk to the file
    emscriptenFS.write(file, value, 0, value.length, null);

    // Continue pumping the next chunk
    return pump();
  }

  return pump().catch((err) => {
    console.error("Stream reading error:", err);
    emscriptenFS.close(file); // Ensure the file is closed in case of error
  });
}

const initWorker = async (modelUrl) => {
  const emscrModule = {
    noInitialRun: true,
    preInit: [
      () => {
        emscrModule.TTY.register(emscrModule.FS.makedev(5, 0), {
          get_char: (tty) => stdin(tty),
          put_char: (tty, val) => {
            tty.output.push(val);
            stdout(val);
          },
          flush: (tty) => (tty.output = []),
          fsync: (tty) => console.log("fsynced stdout (EmscriptenRunnable does nothing in this case)"),
        });

        emscrModule.TTY.register(emscrModule.FS.makedev(6, 0), {
          get_char: (tty) => stdin(tty),
          put_char: (tty, val) => {
            tty.output.push(val);
            stderr(val);
          },
          flush: (tty) => (tty.output = []),
          fsync: (tty) => console.log("fsynced stderr (EmscriptenRunnable does nothing in this case)"),
        });
      },
    ],
  };

  module = await Module(emscrModule);

  await writeToEmscriptenFS(modelUrl, module.FS, model_file_path);
  console.log(`Model downloaded from ${modelUrl} and written to Emscripten FS.`);
  postMessage({
    event: action.INITIALIZED,
  });

};

const run_main = (
  prompt,
  chatml,
  n_predict,
  ctx_size,
  batch_size,
  temp,
  n_gpu_layers,
  top_k,
  top_p,
  no_display_prompt
) => {
  const args = [
    "--model",
    model_file_path,
    "--n-predict",
    n_predict.toString(),
    "--ctx-size",
    ctx_size.toString(),
    "--temp",
    temp.toString(),
    "--top_k",
    top_k.toString(),
    "--top_p",
    top_p.toString(),
    // "--no-mmap",
    "--simple-io",
    "--log-disable",
    "--prompt",
    prompt.toString(),
  ];

  if (!!globalThis.SharedArrayBuffer) {
    args.push("--threads");
    args.push(navigator.hardwareConcurrency.toString());
  }

  if (chatml) {
    args.push("--chatml");
  }

  if (no_display_prompt) {
    args.push("--no-display-prompt");
  }

  module["callMain"](args);

  postMessage({
    event: action.RUN_COMPLETED,
  });
};

// Worker Events
self.addEventListener(
  "message",
  (e) => {
    switch (e.data.event) {
      case action.LOAD:
        // load event
        initWorker(e.data.url);
        break;
      case action.RUN_MAIN:
        // run main
        run_main(
          e.data.prompt,
          e.data.chatml,
          e.data.n_predict,
          e.data.ctx_size,
          e.data.batch_size,
          e.data.temp,
          e.data.n_gpu_layers,
          e.data.top_k,
          e.data.top_p,
          e.data.no_display_prompt
        );

        break;
    }
  },
  false
);
