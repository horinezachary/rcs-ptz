// Makes sim/cam.flv: what the simulated cameras push to the module's RTMP receiver. A stage with a grid and a
// clock, 8 s at 25 fps, 640x360 H.264 Baseline with a keyframe every second, no audio. Needs ffmpeg with
// libx264 and a font. Run once; the file is committed.
//   node scripts/make-sim-video.mjs
import { execFileSync } from 'node:child_process';

const font = '/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf';
const f = [
  'drawgrid=w=80:h=60:t=1:c=white@0.12',
  "drawbox=x='120+100*sin(t*0.8)':y=150:w=90:h=150:color=0xF76B15@0.9:t=fill",
  "drawbox=x='400+60*cos(t*1.1)':y=170:w=70:h=130:color=0x3E63DD@0.9:t=fill",
  'drawbox=x=0:y=300:w=640:h=60:color=0x1a1a1a@1:t=fill',
  `drawtext=fontfile=${font}:text='SIM CAMERA':x=(w-text_w)/2:y=70:fontsize=22:fontcolor=white`,
  `drawtext=fontfile=${font}:text='%{pts\\:hms}':x=(w-text_w)/2:y=100:fontsize=16:fontcolor=white@0.8`
];
execFileSync('ffmpeg', [
  '-y', '-hide_banner', '-loglevel', 'error',
  '-f', 'lavfi', '-i', 'gradients=s=640x360:c0=0x203040:c1=0x405060:r=25:d=8:speed=0.02',
  '-vf', f.join(','),
  '-c:v', 'libx264', '-profile:v', 'baseline', '-pix_fmt', 'yuv420p', '-g', '25', '-bf', '0', '-b:v', '350k', '-an',
  '-f', 'flv', 'sim/cam.flv'
], { stdio: 'inherit' });
console.log('Wrote sim/cam.flv');
