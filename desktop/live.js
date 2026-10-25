// A Gemini Live session: microphone audio in, spoken audio out, over one WebSocket.
// Emits: ready, audio(b64), heard(text), said(text), turn, interrupted, toolCall(calls), toolCancel(ids), closed(reason)
const { EventEmitter } = require('events');
const WebSocket = require('ws');

const URL = 'wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent';

class Live extends EventEmitter {
  constructor({ key, model, voice, system, functions, search = true, handle = '', url = URL }){
    super();
    this.opts = { key, model, voice, system, functions, search, handle, url };
    this.ready = false;
    this.handle = handle;
  }
  connect(){
    const { key, model, voice, system, functions, search, handle, url } = this.opts;
    const ws = this.ws = new WebSocket(`${url}?key=${encodeURIComponent(key)}`);
    ws.on('open', () => {
      const tools = [];
      if (search) tools.push({ googleSearch: {} });
      if (functions.length) tools.push({ functionDeclarations: functions });
      this.send({ setup: {
        model: 'models/' + model,
        generationConfig: { responseModalities: ['AUDIO'], speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: voice } } } },
        systemInstruction: { parts: [{ text: system }] },
        tools,
        inputAudioTranscription: {}, outputAudioTranscription: {},
        sessionResumption: handle ? { handle } : {},
        contextWindowCompression: { slidingWindow: {} }
      } });
    });
    ws.on('message', raw => {
      let m; try { m = JSON.parse(raw.toString()); } catch (e) { return; }
      if (m.setupComplete){ this.ready = true; this.emit('ready'); }
      const sc = m.serverContent;
      if (sc){
        if (sc.interrupted) this.emit('interrupted');
        for (const p of (sc.modelTurn && sc.modelTurn.parts) || []){
          if (p.inlineData && p.inlineData.data) this.emit('audio', p.inlineData.data);
        }
        if (sc.inputTranscription && sc.inputTranscription.text) this.emit('heard', sc.inputTranscription.text);
        if (sc.outputTranscription && sc.outputTranscription.text) this.emit('said', sc.outputTranscription.text);
        if (sc.turnComplete) this.emit('turn');
      }
      if (m.toolCall) this.emit('toolCall', m.toolCall.functionCalls || []);
      if (m.toolCallCancellation) this.emit('toolCancel', m.toolCallCancellation.ids || []);
      if (m.sessionResumptionUpdate && m.sessionResumptionUpdate.resumable && m.sessionResumptionUpdate.newHandle) this.handle = m.sessionResumptionUpdate.newHandle;
      if (m.goAway) this.emit('goAway');
    });
    ws.on('close', (code, reason) => {
      const wasReady = this.ready;
      this.ready = false;
      this.emit('closed', { code, reason: String(reason || ''), wasReady });
    });
    ws.on('error', e => this.emit('error', e));
  }
  send(o){ if (this.ws && this.ws.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(o)); }
  audio(b64){ if (this.ready) this.send({ realtimeInput: { audio: { data: b64, mimeType: 'audio/pcm;rate=16000' } } }); }
  text(text){ if (this.ready) this.send({ clientContent: { turns: [{ role: 'user', parts: [{ text }] }], turnComplete: true } }); }
  toolResponse(functionResponses){ this.send({ toolResponse: { functionResponses } }); }
  close(){ try { this.ws && this.ws.close(); } catch (e) {} }
}

module.exports = Live;
