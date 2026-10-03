// Dn-FamiTracker web port - the hint the status line gives for the effect that was just
// entered (CFamiTrackerView::GetEffectHint()): which effect it is, what its parameter means,
// and what a few of them do differently on the chip or channel they are on or above some
// value of the parameter. This works on numbers only (the effect numbers are the tracker's
// effect_t); the texts are `effectHints` in dnft-editor-strings.mjs, and the key this
// returns is the one of the text.
//
//   effectHintKey(effect, param, { chip, channel, splitPoint })

const EF = {
  SPEED: 1, JUMP: 2, SKIP: 3, HALT: 4, VOLUME: 5, PORTAMENTO: 6, PORTAOFF: 7, SWEEPUP: 8, SWEEPDOWN: 9, ARPEGGIO: 10,
  VIBRATO: 11, TREMOLO: 12, PITCH: 13, DELAY: 14, DAC: 15, PORTA_UP: 16, PORTA_DOWN: 17, DUTY_CYCLE: 18,
  SAMPLE_OFFSET: 19, SLIDE_UP: 20, SLIDE_DOWN: 21, VOLUME_SLIDE: 22, NOTE_CUT: 23, RETRIGGER: 24, DELAYED_VOLUME: 25,
  FDS_MOD_DEPTH: 26, FDS_MOD_SPEED_HI: 27, FDS_MOD_SPEED_LO: 28, DPCM_PITCH: 29, SUNSOFT_ENV_TYPE: 30,
  SUNSOFT_ENV_HI: 31, SUNSOFT_ENV_LO: 32, SUNSOFT_NOISE: 33, VRC7_PORT: 34, VRC7_WRITE: 35, NOTE_RELEASE: 36,
  GROOVE: 37, TRANSPOSE: 38, N163_WAVE_BUFFER: 39, FDS_VOLUME: 40, FDS_MOD_BIAS: 41, PHASE_RESET: 42, HARMONIC: 43,
  TARGET_VOLUME_SLIDE: 44,
};
const EF_COUNT = 45;
// SNDCHIP_* (the chip of a channel) and CHANID_TRIANGLE (the channel index it is on)
const SNDCHIP_VRC7 = 2, SNDCHIP_N163 = 16;
const TRIANGLE = 2;

// `chip`: the chip of the cursor's channel, `channel`: its index, `splitPoint`: the module's
// speed / tempo split point. '' for an effect with no hint (none at all).
export function effectHintKey(effect, param, { chip = 0, channel = 0, splitPoint = 32 } = {}) {
  if (effect >= EF_COUNT)
    return 'undefined';
  switch (effect) {
    case EF.SPEED: return param >= splitPoint ? 'speedTempo' : 'speedSpeed';
    case EF.JUMP: return 'jump';
    case EF.SKIP: return 'skip';
    case EF.HALT: return 'halt';
    case EF.VOLUME: return param >= 0xE0 ? 'lengthMode' : 'lengthIndex';
    case EF.PORTAMENTO: return 'portamento';
    case EF.PORTAOFF: return 'notUsed';
    case EF.SWEEPUP: return 'sweepUp';
    case EF.SWEEPDOWN: return 'sweepDown';
    case EF.ARPEGGIO: return 'arpeggio';
    case EF.VIBRATO: return 'vibrato';
    case EF.TREMOLO: return 'tremolo';
    case EF.PITCH: return 'pitch';
    case EF.DELAY: return 'delay';
    case EF.DAC: return 'dac';
    case EF.PORTA_UP: return 'portaUp';
    case EF.PORTA_DOWN: return 'portaDown';
    case EF.DUTY_CYCLE: return chip === SNDCHIP_N163 ? 'dutyN163' : chip === SNDCHIP_VRC7 ? 'dutyVrc7' : 'duty';
    case EF.SAMPLE_OFFSET: return 'sampleOffset';
    case EF.SLIDE_UP: return 'slideUp';
    case EF.SLIDE_DOWN: return 'slideDown';
    case EF.VOLUME_SLIDE: return 'volumeSlide';
    case EF.NOTE_CUT: return param >= 0x80 && channel === TRIANGLE ? 'cutTriangle' : 'noteCut';
    case EF.RETRIGGER:
      if (channel === TRIANGLE)
        return param ? 'retriggerTriangle' : 'retriggerTriangleOff';
      return 'retriggerDpcm';
    case EF.DELAYED_VOLUME: return 'delayedVolume';
    case EF.FDS_MOD_DEPTH: return param >= 0x80 ? 'fdsModRatio' : 'fdsModDepth';
    case EF.FDS_MOD_SPEED_HI: return param >= 0x10 ? 'fdsAutoMod' : 'fdsModRateHi';
    case EF.FDS_MOD_SPEED_LO: return 'fdsModRateLo';
    case EF.DPCM_PITCH: return 'dpcmPitch';
    case EF.SUNSOFT_ENV_TYPE: return param >= 0x10 ? 'envAuto' : 'envShape';
    case EF.SUNSOFT_ENV_HI: return 'envHi';
    case EF.SUNSOFT_ENV_LO: return 'envLo';
    case EF.SUNSOFT_NOISE: return 'noise5b';
    case EF.VRC7_PORT: return 'vrc7Port';
    case EF.VRC7_WRITE: return 'vrc7Write';
    case EF.NOTE_RELEASE: return 'release';
    case EF.GROOVE: return 'groove';
    case EF.TRANSPOSE: return param >= 0x80 ? 'transposeDown' : 'transposeUp';
    case EF.N163_WAVE_BUFFER: return 'n163Buffer';
    case EF.FDS_VOLUME: return param >= 0x40 ? 'fdsVolumeDecay' : 'fdsVolumeAttack';
    case EF.FDS_MOD_BIAS: return 'fdsBias';
    case EF.PHASE_RESET: return 'phaseReset';
    case EF.HARMONIC: return 'harmonic';
    case EF.TARGET_VOLUME_SLIDE: return 'targetVolume';
    default: return '';
  }
}
