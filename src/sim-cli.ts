// Starts simulated PTZ cameras for development, each pushing its picture to the module's RTMP receiver.
// Nothing here talks to real equipment.
//
//   npm run sim
//
// Each camera answers VISCA over UDP and TCP, Panasonic HTTP and ONVIF on the ports it prints. In Setup, add
// 127.0.0.1 with the protocol and port shown, video "pushed to this unit", then set the stream key it prints
// here (RCS_PTZ_SIM_KEYS=key1,key2), or let the sim push to the keys the module shows.
//   RCS_PTZ_SIM_COUNT=3        cameras (1-4)
//   RCS_PTZ_SIM_RTMP=rtmp://127.0.0.1:1935/live   where to push
import { SimCamera } from './sim/camera.js';
import { SimPusher } from './sim/push.js';

const host = process.env.RCS_PTZ_SIM_HOST ?? '127.0.0.1';
const count = Math.min(4, Math.max(1, Number(process.env.RCS_PTZ_SIM_COUNT) || 2));
const rtmp = process.env.RCS_PTZ_SIM_RTMP ?? 'rtmp://127.0.0.1:1935/live';
const keys = (process.env.RCS_PTZ_SIM_KEYS ?? '').split(',').filter(Boolean);
const cams: SimCamera[] = [];
const pushers: SimPusher[] = [];
for (let i = 0; i < count; i++) {
  const cam = new SimCamera(`Sim PTZ ${i + 1}`, i % 2 ? 'AW-UE150 (sim)' : 'BRC-X400 (sim)');
  const b = 20000 + i * 10;
  const ports = await cam.listen({ viscaUdp: 52381 + i, viscaTcp: 5678 + i, panasonic: b + 1, onvif: b + 2, birddog: b + 3 }, host);
  if (i === 0) await cam.listenDiscovery(52380, host).catch(() => {});
  cams.push(cam);
  const key = keys[i] ?? `simcam${i + 1}`;
  const p = new SimPusher(`${rtmp}/${key}`);
  p.start();
  pushers.push(p);
  console.log(`${cam.name}: VISCA UDP ${ports.viscaUdp}, VISCA TCP ${ports.viscaTcp}, Panasonic HTTP ${ports.panasonic}, ONVIF ${ports.onvif}, BirdDog /about ${ports.birddog}; pushing to ${rtmp}/${key}`);
}
setInterval(() => {
  for (const c of cams) if (c.commands.length) console.log(`${c.name}: ${c.commands.splice(0).map((x) => x.what).join(', ')}`);
}, 1000);

const stop = async () => {
  for (const p of pushers) p.stop();
  await Promise.all(cams.map((c) => c.close()));
  process.exit(0);
};
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
