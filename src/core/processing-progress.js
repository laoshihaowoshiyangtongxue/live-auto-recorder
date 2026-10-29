// FFmpeg reports media time, not output bytes: re-encoding changes file size.
class ProcessingProgress {
  constructor(duration, emit, now = Date.now) {
    this.duration = Number.isFinite(duration) && duration > 0 ? duration : 0;
    this.emit = emit; this.now = now; this.started = now(); this.buffer = '';
    this.seconds = 0; this.lastEmit = 0;
    this.emit({ percent: null, remainingSec: null, updatedAt: now() });
  }
  write(chunk) {
    if(this.pausedAt!==undefined)return;
    this.buffer += chunk.toString();
    const lines = this.buffer.split(/\r?\n/); this.buffer = lines.pop();
    for (const line of lines) {
      const match = /^out_time_us=(-?\d+)$/.exec(line);
      if (match) this.seconds = Math.max(this.seconds, Number(match[1]) / 1e6);
      if (!line.startsWith('progress=')) continue;
      const at = this.now(), elapsed = (at - this.started) / 1000;
      if (this.lastEmit && at - this.lastEmit < 500 && line !== 'progress=end') continue;
      this.lastEmit = at;
      const known = this.duration > 0;
      const remaining = known && this.seconds > 0 && elapsed >= 3 && this.seconds < this.duration
        ? Math.ceil((this.duration - this.seconds) * elapsed / this.seconds) : null;
      this.emit({ percent: known ? Math.min(99, Math.floor(this.seconds / this.duration * 100)) : null,
        remainingSec: remaining, updatedAt: at, processedSec: this.seconds, totalSec: this.duration });
    }
  }
  pause(){if(this.pausedAt===undefined)this.pausedAt=this.now();}
  resume(){if(this.pausedAt!==undefined){this.started+=this.now()-this.pausedAt;this.pausedAt=undefined;this.lastEmit=0;}}
}
module.exports = { ProcessingProgress };
