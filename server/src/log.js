function stamp() {
  return new Date().toTimeString().slice(0, 8); // "HH:MM:SS"
}

export function log(tag, message) {
  console.log(`[${stamp()}] [${tag}] ${message}`);
}

export function logError(tag, message) {
  console.error(`[${stamp()}] [${tag}] ${message}`);
}
