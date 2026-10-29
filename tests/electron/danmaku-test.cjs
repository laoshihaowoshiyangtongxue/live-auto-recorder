const {app,BrowserWindow}=require('electron'),fs=require('node:fs'),path=require('node:path');
const {OBSERVER_JS}=require('../../src/core/danmaku');
app.whenReady().then(async()=>{
 const w=new BrowserWindow({show:false,webPreferences:{contextIsolation:false,backgroundThrottling:false}});
 await w.loadURL('data:text/html,<html><body><div class="webcast-chatroom"><div id="list"></div></div></body></html>');
 await w.webContents.executeJavaScript(`window.messages=[];console.log=text=>window.messages.push(text);document.getElementById('list').innerHTML='<div class="webcast-chatroom___item">甲：唱得好听</div><div class="webcast-chatroom___item">乙：为主播点赞了</div><div class="webcast-chatroom___item">丙：</div>';`);
 await w.webContents.executeJavaScript(OBSERVER_JS);
 await w.webContents.executeJavaScript(`const wrapper=document.createElement('div');wrapper.innerHTML='<div class="webcast-chatroom___item">丁：几点：10:30</div><div class="webcast-chatroom___item">戊：进入了直播间</div>';document.getElementById('list').appendChild(wrapper);document.querySelectorAll('.webcast-chatroom___item')[2].firstChild.textContent='丙：新评论';`);
 await new Promise(r=>setTimeout(r,100));
 const messages=await w.webContents.executeJavaScript('window.messages.map(x=>x.replace("\\u0001DM\\u0001",""))');
 const expected=['甲：唱得好听','丁：几点：10:30','丙：新评论'];
 const pass=messages.length===expected.length&&expected.every(x=>messages.includes(x));
 fs.writeFileSync(process.env.LR_DM_RESULTS||path.join(__dirname,'danmaku-results.json'),JSON.stringify({pass,messages,expected},null,2));app.exit(pass?0:1);
}).catch(e=>{fs.writeFileSync(path.join(__dirname,'danmaku-error.txt'),e.stack);app.exit(1);});
