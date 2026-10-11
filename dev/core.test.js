const fs=require('fs'),vm=require('vm'),D=require('path').join(__dirname,'..')+'/';
const ctx={console,Math};vm.createContext(ctx);
vm.runInContext(fs.readFileSync(D+'js/engine.js','utf8')+'\n'+fs.readFileSync(D+'js/game.js','utf8')+';this.X={Lexicon,createGame,act,cpuAction,viewFor,N}',ctx);
const {Lexicon,createGame,act,cpuAction,viewFor}=ctx.X;const lex=new Lexicon();lex.load(fs.readFileSync(D+'words.txt','utf8'));
let fails=0;const ok=(c,m)=>{if(!c){fails++;console.log('FAIL',m)}};
for (let g=0; g<6; g++){
  const n=2+(g%3);const S=createGame({seats:Array.from({length:n},(_,i)=>({name:'P'+i,kind:'cpu',level:['easy','medium','hard'][i%3]})),slang:g%2==0});
  let guard=0;while(!S.over&&guard++<400){const a=cpuAction(S,S.turn,lex);const r=act(S,S.turn,a,lex);if(!r.ok){ok(false,'cpu move rejected '+r.error);break;}}
  const tiles=S.board.flat().filter(Boolean).length+S.players.reduce((a,p)=>a+p.rack.length,0)+S.bag.length;
  ok(S.over,'game ended'); ok(tiles===100,'tile conservation '+tiles);
  console.log(`game ${g}: ${n} players, ${S.moveNo} moves, scores ${S.players.map(p=>p.score).join('/')}; ${S.log.at(-1).text}`);
}
// adversarial guest moves
const S=createGame({seats:[{name:'A',kind:'human'},{name:'B',kind:'human'}]});
const r0=S.players[0].rack, r1=S.players[1].rack;
ok(!act(S,1,{type:'pass'},lex).ok,'out of turn rejected');
ok(!act(S,0,{type:'play',tiles:[{id:r1[0].id,r:7,c:7}]},lex).ok,'other players tile rejected');
ok(!act(S,0,{type:'play',tiles:[{id:r0[0].id,r:7,c:7},{id:r0[0].id,r:7,c:8}]},lex).ok,'duplicate id rejected');
ok(!act(S,0,{type:'play',tiles:[{id:r0[0].id,r:99,c:7}]},lex).ok,'off board rejected');
ok(!act(S,0,{type:'swap',ids:[12345]},lex).ok,'bad swap rejected');
ok(!act(S,0,null,lex).ok,'null rejected');
const v=viewFor(S,1); ok(!JSON.stringify(v).includes('"bag":[')&&v.rack===S.players[1].rack&&v.players[0].rack===undefined,'view hides bag/others');
ok(act(S,0,{type:'swap',ids:[r0[0].id,r0[1].id]},lex).ok,'swap ok'); ok(S.turn===1,'turn advanced');
console.log(fails?fails+' failures':'all core checks passed');
