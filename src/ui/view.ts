/** 静的UIの骨格。測定前に音程を示すダミーデータを置かない。 */
export function mountView(root: HTMLElement) {
  root.innerHTML = `
  <main class="app">
    <header class="header"><a class="brand" href="./" aria-label="perfectPitch ホーム"><span class="brand-icon" aria-hidden="true">♩</span> perfectPitch</a><span class="local-badge">音声はこの端末の中だけ</span></header>
    <section class="intro"><p class="eyebrow">YOUR VOICE, A LITTLE MUSIC.</p><h1>声のかたちを、<br class="mobile-break">ピアノで聴こう。</h1><p>歌のゆらぎも、話し声の抑揚も。録って、見て、聴き比べる。</p></section>
    <section class="studio" aria-label="声の録音と聴き比べ">
      <div class="toolbar"><fieldset class="segmented"><legend class="sr-only">声の種類</legend><label><input type="radio" name="voiceMode" value="song" checked><span>歌声</span></label><label><input type="radio" name="voiceMode" value="speech"><span>話し声</span></label></fieldset><div class="session-state"><span id="stateDot" class="dot"></span><span id="phase">録音前</span><time id="duration">0:00 / 1:00</time></div></div>
      <div class="timeline-heading"><div><h2>声のタイムライン</h2><p><span class="line-key"></span>声の高さ <span class="bar-key"></span>近くの鍵盤</p></div><label class="range-label">表示音域<select id="range" aria-label="タイムラインの表示音域"><option value="wide">全音域 A1〜B5</option><option value="low">低音 A1〜A3</option><option value="middle">中音 C3〜C5</option><option value="high">高音 C4〜B5</option></select></label></div>
      <div class="timeline-wrap"><canvas id="timeline" role="img" aria-label="横軸は時間、縦軸は音名。録音すると声の連続した高さが表示されます。"></canvas><div id="empty" class="empty"><span aria-hidden="true">〜</span><strong>ここに、あなたの声の軌跡が現れます</strong><p>最初の約0.3秒は静かに。そのあと自由に声を出してみてください。</p></div></div>
      <div class="timeline-footer"><span id="pitchSummary">まだ録音していません</span><span id="rangeNotice"></span></div>
      <div class="transport"><button id="record" class="record-button"><span aria-hidden="true">●</span> 録音する</button><p id="status" role="status" aria-live="polite">歌声を選んでいます。最大60秒まで録音できます。</p></div>
      <section id="review" class="review" aria-label="録音の聴き比べ" hidden>
        <div class="review-top"><fieldset class="segmented"><legend class="sr-only">再生する音</legend><label><input type="radio" name="source" value="original" checked><span>元の声</span></label><label><input type="radio" name="source" value="piano"><span>ピアノ</span></label></fieldset><button id="play" class="play-button">▶ 再生する</button><span id="position">0:00</span></div>
        <label class="seek-label"><span class="sr-only">再生位置</span><input id="seek" type="range" min="0" max="0" step="0.01" value="0" aria-label="再生位置"></label>
        <details class="settings"><summary>再生・解析の設定</summary><div class="settings-body"><label>ピアノの音高<select id="pitchMode"><option value="continuous">元のズレを残す（ピアノ風）</option><option value="rounded">鍵盤に丸める</option></select></label><p id="pitchHelp">中間の音も使い、しゃくりや細かな揺れを残します。</p><button id="reanalyze" class="text-button">元音声から再解析する</button><p id="pianoStatus">ピアノは選択後の再生時に音源を読み込みます。</p></div></details>
      </section>
      <section id="score" aria-label="録音から作る推定の楽譜" hidden></section>
    </section>
    <section class="notes"><div><h2>声から生まれる、小さなメロディ。</h2><p>歌声も話し声も、細かなズレや抑揚を残すピアノ風再生が初期設定です。再生設定から鍵盤に丸めることもできます。</p></div><details><summary>録音について・使える環境</summary><p>一人の近くの声を、静かな場所で。息や雑音、判定できない区間は空白になります。対応音域は55〜1000 Hzです。伴奏や他の人の声の分離はできません。</p><p>音声はブラウザ内で処理し、サーバーへ送信しません。録音は保存されず、この画面を閉じると消えます。ピアノ音源の取得時だけ外部サイトへ接続します。</p><p>HTTPSとAudioWorkletに対応したブラウザが必要です。画面を離れた場合は録音・再生を停止します。iPhone／Androidの実機評価は未完了です。</p><p id="micSettings">マイクの適用設定は録音後に表示します。</p></details></section>
    <footer>perfectPitch <span>声を、音楽の入り口に。</span><small>Piano: FluidR3 / <a href="https://github.com/gleitz/midi-js-soundfonts">MIDI.js Soundfonts</a> · <a href="https://creativecommons.org/licenses/by/3.0/us/">CC BY 3.0</a></small></footer>
  </main>`
  /** 必須要素の欠落を起動時に検出する。 */
  const get = <T extends HTMLElement>(id: string) => {
    const element = root.querySelector<T>(`#${id}`)
    if (!element) throw new Error(`Missing UI: ${id}`)
    return element
  }
  return {
    record: get<HTMLButtonElement>('record'),
    play: get<HTMLButtonElement>('play'),
    reanalyze: get<HTMLButtonElement>('reanalyze'),
    canvas: get<HTMLCanvasElement>('timeline'),
    status: get('status'),
    phase: get('phase'),
    duration: get('duration'),
    empty: get('empty'),
    summary: get('pitchSummary'),
    rangeNotice: get('rangeNotice'),
    review: get('review'),
    range: get<HTMLSelectElement>('range'),
    pitchMode: get<HTMLSelectElement>('pitchMode'),
    pitchHelp: get('pitchHelp'),
    pianoStatus: get('pianoStatus'),
    seek: get<HTMLInputElement>('seek'),
    position: get('position'),
    micSettings: get('micSettings'),
    stateDot: get('stateDot'),
    score: get('score'),
    modes: Array.from(
      root.querySelectorAll<HTMLInputElement>('input[name="voiceMode"]'),
    ),
    sources: Array.from(
      root.querySelectorAll<HTMLInputElement>('input[name="source"]'),
    ),
  }
}
