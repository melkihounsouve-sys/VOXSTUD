(() => {
  'use strict';
  const $ = id => document.getElementById(id);
  const els = {
    input:$('videoInput'), drop:$('dropzone'), video:$('video'), videoWrap:$('videoWrap'),
    fileStatus:$('fileStatus'), videoName:$('videoName'), videoDetails:$('videoDetails'),
    slider:$('volumeSlider'), format:$('outputFormat'), gainValue:$('gainValue'), gainPercent:$('gainPercent'),
    gainDescription:$('gainDescription'), waveform:$('waveform'), waveLabel:$('waveLabel'),
    error:$('errorMessage'), outputName:$('outputName'), exportButton:$('exportButton'),
    exportHint:$('exportHint'), loadProgress:$('loadProgress'), loadBar:$('loadBar'),
    loadPercent:$('loadPercent'), loadMessage:$('loadMessage'), exportProgress:$('exportProgress'),
    exportBar:$('exportBar'), exportPercent:$('exportPercent'), exportMessage:$('exportMessage'),
    successBox:$('successBox'), successMessage:$('successMessage')
  };
  const MAX_FILE_SIZE = 2 * 1024 * 1024 * 1024; // 2 GB guardrail; actual browser limits vary.
  let file = null, objectUrl = null, audioContext = null, sourceNode = null, gainNode = null, analyser = null;
  let decodedBuffer = null, peaks = [], currentGain = 1, recording = null, chunks = [], cancelRequested = false;
  let animationFrame = null, exportStartedAt = 0, exportDuration = 0, audioDestination = null;
  let highPass = null, lowPass = null, gateGain = null, gateMeter = null, noiseEnabled = false, voiceEnabled = false, noiseThreshold = 0.018;

  function showError(message) { els.error.textContent = message; els.error.classList.remove('hidden'); }
  function clearError() { els.error.textContent = ''; els.error.classList.add('hidden'); }
  function formatTime(seconds) {
    if (!Number.isFinite(seconds)) return '—';
    const s = Math.floor(seconds), h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), r = s % 60;
    return h ? `${h}:${String(m).padStart(2,'0')}:${String(r).padStart(2,'0')}` : `${m}:${String(r).padStart(2,'0')}`;
  }
  function formatBytes(bytes) {
    if (!bytes) return '0 B';
    const units = ['B','KB','MB','GB']; const i = Math.min(Math.floor(Math.log(bytes)/Math.log(1024)),3);
    return `${(bytes/1024**i).toFixed(i ? 1 : 0)} ${units[i]}`;
  }
  function setProgress(percent, message) {
    els.loadProgress.classList.remove('hidden'); els.loadBar.style.width = `${percent}%`;
    els.loadPercent.textContent = `${Math.round(percent)}%`; els.loadMessage.textContent = message;
  }
  function setGain(value) {
    currentGain = Math.max(1, Math.min(100, Math.round(Number(value) * 5) / 5));
    els.slider.value = currentGain;
    els.gainValue.textContent = `${currentGain.toFixed(1)}×`;
    els.gainPercent.textContent = `${Math.round(currentGain*100)}%`;
    els.gainDescription.textContent = currentGain === 1 ? 'Volume d’origine' : currentGain < 10 ? 'Amplification modérée' : currentGain < 50 ? 'Forte amplification' : 'Amplification maximale';
    $('summaryGain').textContent = `${currentGain.toFixed(1)}×`;
    document.querySelectorAll('.preset').forEach(btn => btn.classList.toggle('active', Number(btn.dataset.gain) === currentGain));
    if (gainNode && audioContext) gainNode.gain.setTargetAtTime(currentGain, audioContext.currentTime, 0.025);
    drawWaveform();
  }
  function drawWaveform() {
    const canvas = els.waveform, rect = canvas.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1, width = Math.max(1, Math.floor(rect.width*dpr)), height = Math.max(1, Math.floor(104*dpr));
    if (canvas.width !== width || canvas.height !== height) { canvas.width=width; canvas.height=height; }
    const ctx = canvas.getContext('2d'); ctx.clearRect(0,0,width,height);
    const mid = height/2, count = peaks.length || 100, gap = Math.max(1, Math.floor(width/count)), barW = Math.max(1, gap*.58);
    for (let i=0;i<count;i++) {
      const raw = peaks.length ? peaks[i] : 0.035 + Math.abs(Math.sin(i*.21))*.025;
      const amp = Math.min(1, raw * currentGain);
      const barH = Math.max(2*dpr, amp * height * .84);
      const x = i*gap + (gap-barW)/2;
      ctx.fillStyle = peaks.length ? (currentGain > 1 ? '#8277ef' : '#aaa4ed') : '#e0def6';
      const radius = Math.min(barW/2,3*dpr);
      ctx.beginPath(); ctx.roundRect(x,mid-barH/2,barW,barH,radius); ctx.fill();
    }
    if (peaks.length) els.waveLabel.textContent = `Aperçu de l’amplitude · ${currentGain.toFixed(1)}× gain`;
  }
  async function setupAudio() {
    // A media element can only be passed to createMediaElementSource() once.
    // Keep the same audio graph when the user loads another video.
    if (audioContext && sourceNode) {
      if (audioContext.state === 'suspended') {
        try { await audioContext.resume(); } catch (_) {}
      }
      applyAudioEffects();
      return;
    }
    const AudioContextClass = window.AudioContext || window.webkitAudioContext;
    if (!AudioContextClass) throw new Error('Le traitement audio n’est pas pris en charge par ce navigateur. Essayez Chrome ou Edge à jour.');
    audioContext = new AudioContextClass();
    sourceNode = audioContext.createMediaElementSource(els.video);
    gainNode = audioContext.createGain();
    highPass = audioContext.createBiquadFilter(); highPass.type = 'highpass'; highPass.frequency.value = 80; highPass.Q.value = 0.7;
    lowPass = audioContext.createBiquadFilter(); lowPass.type = 'lowpass'; lowPass.frequency.value = 12000; lowPass.Q.value = 0.7;
    gateGain = audioContext.createGain(); gateGain.gain.value = 1;
    gateMeter = audioContext.createScriptProcessor(2048, 1, 1);
    gateMeter.onaudioprocess = event => {
      const data = event.inputBuffer.getChannelData(0);
      let energy = 0;
      for (let i = 0; i < data.length; i += 4) energy += data[i] * data[i];
      const rms = Math.sqrt(energy / Math.max(1, Math.ceil(data.length / 4)));
      const target = noiseEnabled && rms < noiseThreshold ? 0.12 : 1;
      // ScriptProcessorNode must pass samples through; otherwise its output is silence.
      const input = event.inputBuffer.getChannelData(0);
      const output = event.outputBuffer.getChannelData(0);
      output.set(input);
      if (gateGain && audioContext) gateGain.gain.setTargetAtTime(target, audioContext.currentTime, target < gateGain.gain.value ? 0.025 : 0.12);
    };
    analyser = audioContext.createAnalyser(); analyser.fftSize = 256;
    audioDestination = audioContext.createMediaStreamDestination();
    sourceNode.connect(gainNode); gainNode.connect(highPass); highPass.connect(lowPass);
    lowPass.connect(gateMeter); gateMeter.connect(gateGain);
    gateGain.connect(analyser); analyser.connect(audioContext.destination); gateGain.connect(audioDestination);
    gainNode.gain.value = currentGain;
    applyAudioEffects();
  }
  function applyAudioEffects() {
    if (!audioContext || !highPass || !lowPass) return;
    // Voice-focused filtering reduces rumble and hiss without claiming AI source separation.
    highPass.frequency.setTargetAtTime(voiceEnabled ? 120 : 80, audioContext.currentTime, 0.04);
    lowPass.frequency.setTargetAtTime(voiceEnabled ? 4200 : 12000, audioContext.currentTime, 0.04);
    if (gateGain && !noiseEnabled) gateGain.gain.setTargetAtTime(1, audioContext.currentTime, 0.05);
    const wrap = $('noiseSensitivityWrap');
    if (wrap) wrap.classList.toggle('is-active', noiseEnabled);
  }
  function updateNoiseSensitivity() {
    const value = Number($('noiseSensitivity').value);
    noiseThreshold = [0, 0.008, 0.012, 0.018, 0.026, 0.038][value];
    $('noiseSensitivityValue').textContent = ['','Très légère','Légère','Moyenne','Élevée','Très élevée'][value];
  }

  async function createWaveform(blob) {
    peaks = []; drawWaveform(); els.waveLabel.textContent = 'Analyse du son…';
    try {
      const context = new (window.AudioContext || window.webkitAudioContext)();
      const buffer = await context.decodeAudioData(await blob.arrayBuffer());
      const channel = buffer.getChannelData(0), buckets = 140, block = Math.max(1, Math.floor(channel.length/buckets));
      for (let i=0;i<buckets;i++) {
        let max=0; const end=Math.min(channel.length,(i+1)*block);
        for(let j=i*block;j<end;j+=4) max=Math.max(max,Math.abs(channel[j]));
        peaks.push(max);
      }
      decodedBuffer = buffer; await context.close(); drawWaveform();
    } catch (err) {
      // Some codecs cannot be decoded by Web Audio even when the browser can play them.
      peaks=[]; drawWaveform(); els.waveLabel.textContent='Forme d’onde indisponible pour ce codec';
    }
  }
  async function loadVideo(selected) {
    clearError(); els.successBox.classList.add('hidden');
    if (!selected) return;
    if (!selected.type.startsWith('video/')) { showError('Veuillez choisir un fichier vidéo valide.'); return; }
    if (selected.size > MAX_FILE_SIZE) { showError('Ce fichier dépasse la limite de 2 Go. Choisissez une vidéo plus petite.'); return; }
    if (objectUrl) URL.revokeObjectURL(objectUrl);
    file=selected; objectUrl=URL.createObjectURL(file);
    els.input.value=''; els.video.pause(); els.video.removeAttribute('src'); els.video.load();
    els.drop.classList.add('hidden'); els.videoWrap.classList.add('hidden');
    els.exportButton.disabled=true; els.slider.disabled=true;
    document.querySelectorAll('.preset').forEach(b=>b.disabled=true);
    setProgress(10,'Ouverture de la vidéo…');
    els.video.src=objectUrl;
    try {
      await new Promise((resolve,reject)=>{
        const timer=setTimeout(()=>reject(new Error('Le chargement de la vidéo a pris trop de temps.')),30000);
        els.video.onloadedmetadata=()=>{clearTimeout(timer);resolve();};
        els.video.onerror=()=>{clearTimeout(timer);reject(new Error('Votre navigateur ne peut pas ouvrir ce format vidéo.'));};
      });
      setProgress(55,'Lecture des informations vidéo…');
      await setupAudio();
      setProgress(78,'Préparation de la forme d’onde…');
      await createWaveform(file);
      setProgress(100,'Vidéo prête');
      els.videoWrap.classList.remove('hidden');
      els.fileStatus.textContent='Vidéo prête';
      els.videoName.textContent=file.name;
      els.videoDetails.textContent=`${formatTime(els.video.duration)} · ${formatBytes(file.size)}`;
      $('sourceSize').textContent=formatBytes(file.size);
      $('sourceDuration').textContent=formatTime(els.video.duration);
      $('sourceResolution').textContent=`${els.video.videoWidth} × ${els.video.videoHeight}`;
      const base=file.name.replace(/\.[^.]+$/,'').replace(/[^\w\- ]/g,'').trim();
      els.outputName.value=`${base || 'enhanced-video'}-enhanced`;
      els.exportButton.disabled=false; els.slider.disabled=false;
      $('noiseReduction').disabled=false; $('voiceIsolation').disabled=false; $('noiseSensitivity').disabled=false;
      document.querySelectorAll('.preset').forEach(b=>b.disabled=false);
      els.exportHint.textContent='L’exportation lit la vidéo du début à la fin en temps réel.';
      setGain(currentGain);
    } catch(err) {
      $('noiseReduction').disabled=true; $('voiceIsolation').disabled=true; $('noiseSensitivity').disabled=true;
      showError(err.message || 'Impossible de charger cette vidéo.'); els.drop.classList.remove('hidden');
      els.fileStatus.textContent='Impossible de charger la vidéo'; els.loadProgress.classList.add('hidden');
      file=null; objectUrl && URL.revokeObjectURL(objectUrl); objectUrl=null;
    }
  }
  const FORMAT_CANDIDATES = [
    { label:'MP4', extension:'.mp4', types:['video/mp4;codecs="avc1.42E01E,mp4a.40.2"','video/mp4'] },
    { label:'WebM', extension:'.webm', types:['video/webm;codecs=vp9,opus','video/webm;codecs=vp8,opus','video/webm'] },
    { label:'MOV', extension:'.mov', types:['video/quicktime'] },
    { label:'AVI', extension:'.avi', types:['video/x-msvideo'] },
    { label:'MKV', extension:'.mkv', types:['video/x-matroska'] }
  ];
  let supportedFormats = [];

  function configureExportFormats() {
    const recorderAvailable = !!window.MediaRecorder;
    supportedFormats = recorderAvailable ? FORMAT_CANDIDATES.map(format => {
      const mime = format.types.find(type => MediaRecorder.isTypeSupported(type));
      return mime ? { ...format, mime } : null;
    }).filter(Boolean) : [];
    els.format.innerHTML = '';
    supportedFormats.forEach(format => {
      const option = document.createElement('option');
      option.value = format.extension;
      option.textContent = format.label;
      els.format.appendChild(option);
    });
    if (!supportedFormats.some(f => f.extension === '.mp4') &&
        supportedFormats.some(f => f.extension === '.webm')) {
      // WebM remains the default when MP4 recording is not available in this browser.
      els.format.value = '.webm';
    } else if (supportedFormats.some(f => f.extension === '.mp4')) {
      els.format.value = '.mp4';
    }
    updateFormatSummary();
    if (!supportedFormats.length) {
      els.format.disabled = true;
      els.exportHint.textContent = 'Ce navigateur ne propose aucun format vidéo compatible. Essayez une version récente de Chrome ou Edge.';
    }
  }
  function selectedFormat() {
    return supportedFormats.find(format => format.extension === els.format.value) || supportedFormats[0] || null;
  }
  function updateFormatSummary() {
    const format = selectedFormat();
    if (!format) return;
    $('extensionLabel').textContent = format.extension;
    $('summaryFormat').textContent = format.label;
  }
  function updateExportProgress() {
    if (!recording || cancelRequested) return;
    const elapsed=(performance.now()-exportStartedAt)/1000;
    const pct=Math.min(99, elapsed/Math.max(1,exportDuration)*100);
    els.exportBar.style.width=`${pct}%`; els.exportPercent.textContent=`${Math.floor(pct)}%`;
    els.exportMessage.textContent=`Enregistrement de la vidéo… ${formatTime(Math.min(elapsed,exportDuration))} / ${formatTime(exportDuration)}`;
    animationFrame=requestAnimationFrame(updateExportProgress);
  }
  async function startExport() {
    clearError(); els.successBox.classList.add('hidden');
    if (!file || !window.MediaRecorder) { showError('L’exportation vidéo n’est pas prise en charge. Essayez Chrome ou Edge à jour.'); return; }
    if (!els.video.duration || !Number.isFinite(els.video.duration)) { showError('Impossible de déterminer la durée de la vidéo.'); return; }
    const format=selectedFormat();
    if (!format) { showError('Aucun format d’exportation compatible. Essayez Chrome ou Edge à jour.'); return; }
    const mime=format.mime;
    const cleanName=els.outputName.value.trim().replace(/[\\/:*?"<>|]/g,'-') || 'enhanced-video';
    if (cleanName.length>100) { showError('Le nom du fichier doit comporter moins de 100 caractères.'); return; }
    let saveHandle=null;
    // Request the destination while the user gesture is still active.
    if (window.showSaveFilePicker) {
      try {
        saveHandle=await window.showSaveFilePicker({
          suggestedName:`${cleanName}${format.extension}`,
          types:[{description:`Enhanced ${format.label} video`,accept:{[mime.split(';')[0]]:[format.extension]}}]
        });
      } catch(err) {
        if (err.name==='AbortError') return;
        // Fall back to a standard browser download if the picker is unavailable/blocked.
      }
    }
    try {
      if (audioContext.state==='suspended') await audioContext.resume();
      els.video.pause(); els.video.currentTime=0;
      await new Promise(resolve=>{
        if (els.video.readyState>=2) resolve();
        else els.video.oncanplay=resolve;
      });
      const videoStream = els.video.captureStream ? els.video.captureStream() :
                          (els.video.mozCaptureStream ? els.video.mozCaptureStream() : null);
      if (!videoStream) throw new Error('Ce navigateur ne peut pas capturer le flux vidéo. Utilisez Chrome ou Edge à jour.');
      const combined=new MediaStream([
        ...videoStream.getVideoTracks(),
        ...audioDestination.stream.getAudioTracks()
      ]);
      chunks=[]; cancelRequested=false; exportDuration=els.video.duration;
      const videoTrack = videoStream.getVideoTracks()[0];
      const trackSettings = videoTrack && videoTrack.getSettings ? videoTrack.getSettings() : {};
      const width = trackSettings.width || els.video.videoWidth || 1920;
      const height = trackSettings.height || els.video.videoHeight || 1080;
      const fps = trackSettings.frameRate || 30;
      // Preserve the captured frame cadence and use a generous bitrate to minimize visible
      // re-encoding artifacts. The video is not intentionally resized, filtered, or retimed.
      const videoBitsPerSecond = Math.min(50000000, Math.max(8000000,
        Math.round((width * height * Math.min(fps, 60)) * 0.18)));
      recording=new MediaRecorder(combined,{mimeType:mime,videoBitsPerSecond,audioBitsPerSecond:256000});
      recording.ondataavailable=e=>{if(e.data && e.data.size) chunks.push(e.data);};
      recording.onerror=()=>finishExportError(new Error('Une erreur est survenue pendant l’enregistrement.'));
      recording.onstop=async()=>{
        cancelAnimationFrame(animationFrame);
        combined.getTracks().forEach(t=>t.stop());
        if (cancelRequested) { chunks=[]; resetExportUI(); return; }
        const blob=new Blob(chunks,{type:mime}); chunks=[];
        if (!blob.size) { finishExportError(new Error('Le fichier exporté est vide.')); return; }
        try {
          const extension=format.extension;
          if (saveHandle) {
            const writable=await saveHandle.createWritable();
            await writable.write(blob); await writable.close();
            els.successMessage.textContent=`${saveHandle.name} (${formatBytes(blob.size)}) enregistré.`;
          } else {
            const url=URL.createObjectURL(blob), a=document.createElement('a');
            a.href=url; a.download=`${cleanName}${extension}`; document.body.appendChild(a); a.click(); a.remove();
            setTimeout(()=>URL.revokeObjectURL(url),60000);
            els.successMessage.textContent=`${cleanName}${extension} (${formatBytes(blob.size)}) — vérifiez le dossier Téléchargements de votre navigateur.`;
          }
          els.exportProgress.classList.add('hidden'); els.successBox.classList.remove('hidden');
          els.exportHint.textContent='Votre vidéo originale n’a pas été modifiée.';
          els.exportButton.disabled=false; recording=null;
        } catch(err) { finishExportError(new Error(`Impossible d’enregistrer le fichier : ${err.message}`)); }
      };
      recording.start(1000);
      els.exportButton.disabled=true; els.exportButton.textContent='Exportation…';
      els.exportProgress.classList.remove('hidden'); els.exportBar.style.width='0%';
      els.exportMessage.textContent='Démarrage de la vidéo…'; exportStartedAt=performance.now();
      updateExportProgress();
      els.video.onended=()=>{ if(recording && recording.state!=='inactive') recording.stop(); };
      await els.video.play();
    } catch(err) { finishExportError(err); }
  }
  function finishExportError(err) {
    // Prevent the recorder's subsequent stop event from treating a failed export as successful.
    cancelRequested = true;
    if (recording && recording.state!=='inactive') { try{recording.stop();}catch(_){} }
    recording=null; cancelAnimationFrame(animationFrame); showError(err.message || 'Échec de l’exportation.'); resetExportUI();
  }
  function resetExportUI() {
    els.exportProgress.classList.add('hidden'); els.exportButton.disabled=!file;
    els.exportButton.innerHTML='<svg viewBox="0 0 24 24"><path d="M12 3v12m0 0 4.5-4.5M12 15l-4.5-4.5M4 17v3h16v-3"/></svg> Exporter la vidéo améliorée';
    els.exportHint.textContent='Vous pouvez ajuster les réglages et recommencer l’exportation.';
  }
  function cancelExport() {
    cancelRequested=true; els.video.pause();
    if(recording && recording.state!=='inactive') recording.stop();
    else resetExportUI();
  }

  els.input.addEventListener('change',e=>loadVideo(e.target.files[0]));
  els.drop.addEventListener('dragover',e=>{e.preventDefault();els.drop.classList.add('dragover');});
  els.drop.addEventListener('dragleave',()=>els.drop.classList.remove('dragover'));
  els.drop.addEventListener('drop',e=>{e.preventDefault();els.drop.classList.remove('dragover');loadVideo(e.dataTransfer.files[0]);});
  els.slider.addEventListener('input',e=>setGain(e.target.value));
  $('noiseReduction').addEventListener('change', e=>{ noiseEnabled=e.target.checked; applyAudioEffects(); });
  $('voiceIsolation').addEventListener('change', e=>{ voiceEnabled=e.target.checked; applyAudioEffects(); });
  $('noiseSensitivity').addEventListener('input', updateNoiseSensitivity);
  els.format.addEventListener('change',updateFormatSummary);
  document.querySelectorAll('.preset').forEach(btn=>btn.addEventListener('click',()=>setGain(btn.dataset.gain)));
  els.exportButton.addEventListener('click',startExport);
  $('cancelExport').addEventListener('click',cancelExport);
  els.video.addEventListener('loadedmetadata',()=>{ if(file) els.videoDetails.textContent=`${formatTime(els.video.duration)} · ${formatBytes(file.size)}`; });
  els.video.addEventListener('play',()=>{ if(audioContext && audioContext.state === 'suspended') audioContext.resume().catch(()=>{}); });
  window.addEventListener('resize',drawWaveform);
  window.addEventListener('beforeunload',()=>{if(objectUrl)URL.revokeObjectURL(objectUrl);});
  configureExportFormats();
  updateNoiseSensitivity();
  setGain(1); drawWaveform();
})();
