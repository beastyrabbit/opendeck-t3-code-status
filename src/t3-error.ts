export type T3ClientErrorCode =
	| "offline"
	| "unsafe-origin"
	| "invalid-response"
	| "cache-unavailable"
	| "cache-read-failed";

export class T3ClientError extends Error {
	constructor(readonly code: T3ClientErrorCode) {
		super(code);
		this.name = "T3ClientError";
	}
}
