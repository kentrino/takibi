export class TakibiProtocolError extends TypeError {
  constructor(message: string) {
    super(message);
    this.name = "TakibiProtocolError";
  }
}
