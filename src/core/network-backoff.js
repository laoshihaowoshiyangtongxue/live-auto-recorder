// Network-wide transient failures (such as changing VPN routes) should not
// cause every room to hammer the same broken session at once.
class NetworkBackoff {
  constructor(now=()=>Date.now()){this.now=now;this.failures=0;this.until=0;}
  isNetworkError(error){return /failed to fetch|fetch failed|network|internet disconnected|err_(?:internet|network|connection|proxy|tunnel|name_not_resolved)|econnreset|econnrefused|enetunreach|etimedout|页内fetch超时|页面加载超时/i.test(String(error?.message||error||''));}
  failure(error){if(!this.isNetworkError(error))return false;this.failures++;if(this.failures>=3){const delay=Math.min(15000,3000*2**Math.min(3,this.failures-3));this.until=Math.max(this.until,this.now()+delay);}return true;}
  shouldWait(){return this.now()<this.until;}
  success(){this.failures=0;this.until=0;}
}
module.exports={NetworkBackoff};
