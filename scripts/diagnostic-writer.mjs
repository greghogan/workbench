// Generated from diagnostic-writer.mts; edit the TypeScript source.
class BoundedDiagnosticWriter {
  constructor(output, notice, limit = 65536) {
    this.output = output;
    this.notice = notice;
    this.limit = limit;
    output.on("error", this.error);
  }
  output;
  notice;
  limit;
  omitted = 0;
  failure;
  pending = 0;
  waiting = false;
  error = (error) => {
    this.failure ??= error;
  };
  drained = () => {
    this.waiting = false;
    this.flushOmissions();
  };
  write(text) {
    if (this.failure) return false;
    if (this.output.writableLength > this.limit) {
      this.omitted++;
      this.pending++;
      if (!this.waiting) {
        this.waiting = true;
        this.output.once("drain", this.drained);
      }
      return false;
    }
    try {
      this.output.write(text);
      return true;
    } catch (error) {
      this.failure ??= error;
      return false;
    }
  }
  flushOmissions(final = false) {
    if (!this.pending || this.failure) return;
    const omitted = this.pending;
    if (final) {
      try {
        this.output.write(this.notice(omitted));
        this.pending = 0;
      } catch (error) {
        this.failure ??= error;
      }
    } else if (this.write(this.notice(omitted))) this.pending = 0;
  }
  dispose() {
    this.output.removeListener("error", this.error);
    this.output.removeListener("drain", this.drained);
  }
}
export {
  BoundedDiagnosticWriter
};
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJzb3VyY2VzIjpbImRpYWdub3N0aWMtd3JpdGVyLm10cyJdLCJzb3VyY2VzQ29udGVudCI6WyJpbXBvcnQgdHlwZSB7IFdyaXRhYmxlIH0gZnJvbSBcIm5vZGU6c3RyZWFtXCI7XG5cbi8qKiBBIGJvdW5kZWQgb2JzZXJ2YXRpb25hbCBzaW5rOiBvbmUgb21pc3Npb24gbm90aWNlIGFmdGVyIGRyYWluLCB3aXRoIGZhaWx1cmVzIGF2YWlsYWJsZSB0byBpdHMgb3duZXIuICovXG5leHBvcnQgY2xhc3MgQm91bmRlZERpYWdub3N0aWNXcml0ZXIge1xuICBvbWl0dGVkID0gMDtcbiAgZmFpbHVyZTogdW5rbm93bjtcbiAgcHJpdmF0ZSBwZW5kaW5nID0gMDtcbiAgcHJpdmF0ZSB3YWl0aW5nID0gZmFsc2U7XG4gIHByaXZhdGUgcmVhZG9ubHkgZXJyb3IgPSAoZXJyb3I6IHVua25vd24pID0+IHtcbiAgICB0aGlzLmZhaWx1cmUgPz89IGVycm9yO1xuICB9O1xuICBwcml2YXRlIHJlYWRvbmx5IGRyYWluZWQgPSAoKSA9PiB7XG4gICAgdGhpcy53YWl0aW5nID0gZmFsc2U7XG4gICAgdGhpcy5mbHVzaE9taXNzaW9ucygpO1xuICB9O1xuICBjb25zdHJ1Y3RvcihcbiAgICBwcml2YXRlIHJlYWRvbmx5IG91dHB1dDogV3JpdGFibGUsXG4gICAgcHJpdmF0ZSByZWFkb25seSBub3RpY2U6IChvbWl0dGVkOiBudW1iZXIpID0+IHN0cmluZyxcbiAgICBwcml2YXRlIHJlYWRvbmx5IGxpbWl0ID0gNjU1MzYsXG4gICkge1xuICAgIG91dHB1dC5vbihcImVycm9yXCIsIHRoaXMuZXJyb3IpO1xuICB9XG4gIHdyaXRlKHRleHQ6IHN0cmluZyk6IGJvb2xlYW4ge1xuICAgIGlmICh0aGlzLmZhaWx1cmUpIHJldHVybiBmYWxzZTtcbiAgICBpZiAodGhpcy5vdXRwdXQud3JpdGFibGVMZW5ndGggPiB0aGlzLmxpbWl0KSB7XG4gICAgICB0aGlzLm9taXR0ZWQrKztcbiAgICAgIHRoaXMucGVuZGluZysrO1xuICAgICAgaWYgKCF0aGlzLndhaXRpbmcpIHtcbiAgICAgICAgdGhpcy53YWl0aW5nID0gdHJ1ZTtcbiAgICAgICAgdGhpcy5vdXRwdXQub25jZShcImRyYWluXCIsIHRoaXMuZHJhaW5lZCk7XG4gICAgICB9XG4gICAgICByZXR1cm4gZmFsc2U7XG4gICAgfVxuICAgIHRyeSB7XG4gICAgICB0aGlzLm91dHB1dC53cml0ZSh0ZXh0KTtcbiAgICAgIHJldHVybiB0cnVlO1xuICAgIH0gY2F0Y2ggKGVycm9yKSB7XG4gICAgICB0aGlzLmZhaWx1cmUgPz89IGVycm9yO1xuICAgICAgcmV0dXJuIGZhbHNlO1xuICAgIH1cbiAgfVxuICBmbHVzaE9taXNzaW9ucyhmaW5hbCA9IGZhbHNlKTogdm9pZCB7XG4gICAgaWYgKCF0aGlzLnBlbmRpbmcgfHwgdGhpcy5mYWlsdXJlKSByZXR1cm47XG4gICAgY29uc3Qgb21pdHRlZCA9IHRoaXMucGVuZGluZztcbiAgICBpZiAoZmluYWwpIHtcbiAgICAgIHRyeSB7XG4gICAgICAgIHRoaXMub3V0cHV0LndyaXRlKHRoaXMubm90aWNlKG9taXR0ZWQpKTtcbiAgICAgICAgdGhpcy5wZW5kaW5nID0gMDtcbiAgICAgIH0gY2F0Y2ggKGVycm9yKSB7XG4gICAgICAgIHRoaXMuZmFpbHVyZSA/Pz0gZXJyb3I7XG4gICAgICB9XG4gICAgfSBlbHNlIGlmICh0aGlzLndyaXRlKHRoaXMubm90aWNlKG9taXR0ZWQpKSkgdGhpcy5wZW5kaW5nID0gMDtcbiAgfVxuICBkaXNwb3NlKCk6IHZvaWQge1xuICAgIHRoaXMub3V0cHV0LnJlbW92ZUxpc3RlbmVyKFwiZXJyb3JcIiwgdGhpcy5lcnJvcik7XG4gICAgdGhpcy5vdXRwdXQucmVtb3ZlTGlzdGVuZXIoXCJkcmFpblwiLCB0aGlzLmRyYWluZWQpO1xuICB9XG59XG4iXSwibWFwcGluZ3MiOiI7QUFHTyxNQUFNLHdCQUF3QjtBQUFBLEVBWW5DLFlBQ21CLFFBQ0EsUUFDQSxRQUFRLE9BQ3pCO0FBSGlCO0FBQ0E7QUFDQTtBQUVqQixXQUFPLEdBQUcsU0FBUyxLQUFLLEtBQUs7QUFBQSxFQUMvQjtBQUFBLEVBTG1CO0FBQUEsRUFDQTtBQUFBLEVBQ0E7QUFBQSxFQWRuQixVQUFVO0FBQUEsRUFDVjtBQUFBLEVBQ1EsVUFBVTtBQUFBLEVBQ1YsVUFBVTtBQUFBLEVBQ0QsUUFBUSxDQUFDLFVBQW1CO0FBQzNDLFNBQUssWUFBWTtBQUFBLEVBQ25CO0FBQUEsRUFDaUIsVUFBVSxNQUFNO0FBQy9CLFNBQUssVUFBVTtBQUNmLFNBQUssZUFBZTtBQUFBLEVBQ3RCO0FBQUEsRUFRQSxNQUFNLE1BQXVCO0FBQzNCLFFBQUksS0FBSyxRQUFTLFFBQU87QUFDekIsUUFBSSxLQUFLLE9BQU8saUJBQWlCLEtBQUssT0FBTztBQUMzQyxXQUFLO0FBQ0wsV0FBSztBQUNMLFVBQUksQ0FBQyxLQUFLLFNBQVM7QUFDakIsYUFBSyxVQUFVO0FBQ2YsYUFBSyxPQUFPLEtBQUssU0FBUyxLQUFLLE9BQU87QUFBQSxNQUN4QztBQUNBLGFBQU87QUFBQSxJQUNUO0FBQ0EsUUFBSTtBQUNGLFdBQUssT0FBTyxNQUFNLElBQUk7QUFDdEIsYUFBTztBQUFBLElBQ1QsU0FBUyxPQUFPO0FBQ2QsV0FBSyxZQUFZO0FBQ2pCLGFBQU87QUFBQSxJQUNUO0FBQUEsRUFDRjtBQUFBLEVBQ0EsZUFBZSxRQUFRLE9BQWE7QUFDbEMsUUFBSSxDQUFDLEtBQUssV0FBVyxLQUFLLFFBQVM7QUFDbkMsVUFBTSxVQUFVLEtBQUs7QUFDckIsUUFBSSxPQUFPO0FBQ1QsVUFBSTtBQUNGLGFBQUssT0FBTyxNQUFNLEtBQUssT0FBTyxPQUFPLENBQUM7QUFDdEMsYUFBSyxVQUFVO0FBQUEsTUFDakIsU0FBUyxPQUFPO0FBQ2QsYUFBSyxZQUFZO0FBQUEsTUFDbkI7QUFBQSxJQUNGLFdBQVcsS0FBSyxNQUFNLEtBQUssT0FBTyxPQUFPLENBQUMsRUFBRyxNQUFLLFVBQVU7QUFBQSxFQUM5RDtBQUFBLEVBQ0EsVUFBZ0I7QUFDZCxTQUFLLE9BQU8sZUFBZSxTQUFTLEtBQUssS0FBSztBQUM5QyxTQUFLLE9BQU8sZUFBZSxTQUFTLEtBQUssT0FBTztBQUFBLEVBQ2xEO0FBQ0Y7IiwibmFtZXMiOltdLCJmaWxlIjoic2NyaXB0cy9kaWFnbm9zdGljLXdyaXRlci5tanMifQ==
