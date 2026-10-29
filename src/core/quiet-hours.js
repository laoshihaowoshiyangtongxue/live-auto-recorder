const CLOCK = /^(?:[01]\d|2[0-3]):[0-5]\d$/;
function validClock(value) { return typeof value === 'string' && CLOCK.test(value); }
function quietHours(settings = {}, now = new Date()) {
  const start = settings.postQuietStart || '23:00', end = settings.postQuietEnd || '08:00';
  if (!settings.postQuietEnabled || !validClock(start) || !validClock(end) || start === end) return { active:false };
  const minutes = text => Number(text.slice(0,2))*60+Number(text.slice(3));
  const a=minutes(start),b=minutes(end),cur=now.getHours()*60+now.getMinutes();
  const active = a < b ? cur >= a && cur < b : cur >= a || cur < b;
  if (!active) return { active:false, start, end };
  const resume = new Date(now);resume.setHours(Math.floor(b/60),b%60,0,0);
  if(resume <= now)resume.setDate(resume.getDate()+1);
  return { active:true, start, end, resumeAt:resume.getTime() };
}
module.exports={quietHours,validClock};
