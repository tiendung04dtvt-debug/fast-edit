const res = await fetch('http://127.0.0.1:4177/api/video/beauty', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    projectId: '6a6021d9-9563-4e7e-a25f-c9b9bfce22c7',
    videoName: 'cut_1793045207768_merged_1793044161780_capcut.mp4',
    sharpen: 50,
    beauty: 30,
    bgMode: 'original'
  })
});

const data = await res.json();
console.log('Result:', data);
