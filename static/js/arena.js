/* =========================================================
   CHESS ARENA PRO — arena.js
   ========================================================= */

// ─── GLOBAL STATE ────────────────────────────────────────
var board        = null;
var game         = new Chess();
var socket       = io();
var myColor      = 'w';
var room         = "duel_" + Math.random().toString(36).substr(2, 9);
var historyFens  = [];
var viewIndex    = 0;
var selectedSquare = null;
var assistEnabled  = true;
var soundEnabled   = true;
var movesCount   = 0;
var gameStatus   = 'idle';
var isSpectator  = false;
var currentPGN   = '';
var moveList     = [];
var isLocalMode    = false;
var autoFlipEnabled = true;
var localClockInterval = null;
var localClocks  = { w: 0, b: 0, active: null };
var localJokers  = 3;

// ─── AUDIO (Web Audio API) ───────────────────────────────
var audioCtx = null;
function getACtx() {
    if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    return audioCtx;
}
function playTone(freq, type, dur, vol) {
    if (!soundEnabled) return;
    try {
        var ctx = getACtx();
        var osc = ctx.createOscillator(), gain = ctx.createGain();
        osc.connect(gain); gain.connect(ctx.destination);
        osc.type = type || 'sine'; osc.frequency.value = freq;
        gain.gain.setValueAtTime(vol || 0.25, ctx.currentTime);
        gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + dur);
        osc.start(); osc.stop(ctx.currentTime + dur);
    } catch(e) {}
}
function sfxMove()    { playTone(440, 'triangle', 0.1, 0.18); }
function sfxCapture() { playTone(220, 'sawtooth', 0.18, 0.3); }
function sfxCheck()   { playTone(880, 'square', 0.25, 0.35); }
function sfxWin()     { [523,659,784,1047].forEach(function(f,i){ setTimeout(function(){ playTone(f,'sine',0.35,0.4); }, i*160); }); }
function sfxLose()    { [523,415,330].forEach(function(f,i){ setTimeout(function(){ playTone(f,'sine',0.45,0.3); }, i*210); }); }
function sfxDraw()    { [440,440].forEach(function(f,i){ setTimeout(function(){ playTone(f,'triangle',0.3,0.2); }, i*300); }); }

function toggleSound() {
    soundEnabled = !soundEnabled;
    var btn = document.getElementById('sound-btn');
    if (btn) { btn.textContent = soundEnabled ? '🔊 SON ON' : '🔇 MUET'; }
}

// ─── THEME ───────────────────────────────────────────────
var currentTheme = localStorage.getItem('arena_theme') || 'classic';
function setTheme(t) {
    currentTheme = t;
    localStorage.setItem('arena_theme', t);
    document.body.dataset.theme = t;
    document.querySelectorAll('.theme-dot').forEach(function(d) {
        d.classList.toggle('active', d.dataset.theme === t);
    });
}
setTheme(currentTheme);

// ─── MOVE NOTATION ───────────────────────────────────────
function addMoveToNotation(san, color) {
    moveList.push({ san: san, color: color });
    renderMoveList();
}
function loadMoveHistory(history) {
    moveList = (history || []).map(function(m) { return { san: m.san, color: m.color }; });
    renderMoveList();
}
function renderMoveList() {
    var el = document.getElementById('move-list-body');
    if (!el) return;
    var html = '';
    for (var i = 0; i < moveList.length; i += 2) {
        var n = Math.floor(i / 2) + 1;
        var w = moveList[i]   ? '<span class="move-san white-move">' + esc(moveList[i].san) + '</span>' : '';
        var b = moveList[i+1] ? '<span class="move-san black-move">' + esc(moveList[i+1].san) + '</span>' : '';
        html += '<div class="move-row"><span class="move-num">' + n + '.</span>' + w + b + '</div>';
    }
    el.innerHTML = html;
    el.scrollTop = el.scrollHeight;
}
function esc(s) { return $('<span>').text(s).html(); }

// ─── LAST MOVE HIGHLIGHT ─────────────────────────────────
function highlightLastMove(from, to) {
    $('#board .square-55d63').removeClass('last-move-from last-move-to');
    if (from) $('#board .square-' + from).addClass('last-move-from');
    if (to)   $('#board .square-' + to).addClass('last-move-to');
}

// ─── CHAT ────────────────────────────────────────────────
function sendChat() {
    var val = $('#chat-input').val().trim();
    if (!val) return;
    socket.emit('chat_msg', { room: room, msg: val });
    $('#chat-input').val('');
}
$('#chat-input').on('keydown', function(e) { if (e.key === 'Enter') sendChat(); });

function appendChatMsg(user, msg, isMine) {
    var cls = isMine ? 'mine' : 'theirs';
    var html = '<div class="chat-bubble ' + cls + '">'
             + '<span class="chat-user">' + esc(user) + '</span>'
             + '<span>' + esc(msg) + '</span></div>';
    var el = document.getElementById('chat-messages');
    if (!el) return;
    el.insertAdjacentHTML('beforeend', html);
    el.scrollTop = el.scrollHeight;
}

// ─── QR CODE ─────────────────────────────────────────────
var localUrl = 'http://' + LOCAL_IP + ':5000';
new QRCode(document.getElementById('qrcode'), { text: localUrl, width: 200, height: 200 });
$('#ip-text').text('Lien : ' + localUrl);
function toggleQR() { $('#qrModal').fadeToggle(150); }

// ─── LOBBY ───────────────────────────────────────────────
function showSalons() {
    $('#main-lobby-btns').addClass('hidden');
    $('#salons-list').removeClass('hidden');
    $('#config-duel').addClass('hidden');
    socket.emit('get_public_rooms');
    loadLeaderboard();
}
function showConfig(mode) {
    $('#main-lobby-btns').addClass('hidden');
    $('#salons-list').addClass('hidden');
    $('#config-duel').removeClass('hidden');
    if (mode === 'hva') {
        $('#config-title').text("🚀 DUEL CONTRE L'IA");
        $('#ia-only-config').removeClass('hidden');
        $('#start-duel-btn').off('click').on('click', startIA);
    } else if (mode === 'local') {
        $('#config-title').text('🖥️ MULTI LOCAL');
        $('#ia-only-config').addClass('hidden');
        $('#start-duel-btn').off('click').on('click', startLocal);
    } else {
        $('#config-title').text('🌐 CRÉER UN SALON MULTI');
        $('#ia-only-config').addClass('hidden');
        $('#start-duel-btn').off('click').on('click', createPublicRoom);
    }
}
function cancelConfig() {
    $('#main-lobby-btns').removeClass('hidden');
    $('#salons-list').addClass('hidden');
    $('#config-duel').addClass('hidden');
}
function enterGame() {
    $('#lobby-view').addClass('hidden');
    // Remove display: contents as we now use CSS grid classes
    $('#game-view').removeClass('hidden').attr('style', '');
    board.resize();
    gameStatus = 'playing';
}
function startIA() {
    assistEnabled = $('#move-assist').is(':checked');
    updateAssistUI();
    enterGame();
    socket.emit('create_room', {
        room: room, mode: 'hva',
        level: $('#ia-level').val(),
        time: $('#base-time').val(),
        inc: $('#inc-time').val()
    });
}
function createPublicRoom() {
    assistEnabled = $('#move-assist').is(':checked');
    updateAssistUI();
    enterGame();
    socket.emit('create_room', {
        room: room, mode: 'hvh', level: 1,
        time: $('#base-time').val(),
        inc: $('#inc-time').val()
    });
}
function startLocal() {
    isLocalMode = true;
    autoFlipEnabled = true;
    assistEnabled = $('#move-assist').is(':checked');
    updateAssistUI();
    enterGame();
    game = new Chess(); board.start();
    board.orientation('white');
    myColor = 'w'; // not really used in local but for compatibility
    historyFens = [game.fen()]; viewIndex = 0;
    movesCount = 0; moveList = []; selectedSquare = null;
    gameStatus = 'playing'; currentPGN = '';
    // Setup local clocks
    var baseTime = parseInt($('#base-time').val()) * 60;
    localClocks = { w: baseTime, b: baseTime, active: null };
    $('#clock-bottom').text(fmtTime(baseTime));
    $('#clock-top').text(fmtTime(baseTime));
    $('#player-name').text('BLANCS');
    $('#opponent-name').text('NOIRS');
    // Show Joker button in Local Mode
    $('#joker-btn').removeClass('hidden');
    localJokers = 3;
    $('#joker-display').text(localJokers);

    $('#chat-panel').addClass('hidden');
    updateStatus();
    updateAbortResignBtn();
}
function joinPublicRoom(rid) {
    room = rid;
    enterGame();
    socket.emit('join_room', { room: rid });
}

// ─── LEADERBOARD ─────────────────────────────────────────
function loadLeaderboard() {
    $.getJSON('/api/leaderboard', function(data) {
        var body = $('#leaderboard-body');
        if (!body.length) return;
        body.empty();
        if (!data.length) {
            body.html('<tr><td colspan="4" style="padding:20px;text-align:center;color:#555">Aucune partie HvH jouée</td></tr>');
            return;
        }
        data.forEach(function(p, i) {
            var total = p.wins + p.losses + p.draws;
            var wr = total > 0 ? Math.round(p.wins / total * 100) + '%' : '—';
            var rank = i === 0 ? '🥇' : i === 1 ? '🥈' : i === 2 ? '🥉' : '#' + (i+1);
            body.append('<tr>'
                + '<td class="rank-cell">' + rank + '</td>'
                + '<td>' + esc(p.username) + '</td>'
                + '<td><span class="stat-win">' + p.wins + 'V</span> '
                +     '<span class="stat-draw">' + p.draws + 'N</span> '
                +     '<span class="stat-loss">' + p.losses + 'D</span></td>'
                + '<td>' + wr + '</td>'
                + '</tr>');
        });
        $('#leaderboard-section').removeClass('hidden');
    });
}

// ─── SOCKET EVENTS ───────────────────────────────────────
socket.on('rooms_list', function(rooms) {
    var c = $('#rooms-container'); c.empty();
    if (!rooms.length) {
        c.html('<div style="padding:40px;text-align:center;color:#555">Aucun duel en attente...</div>');
        return;
    }
    rooms.forEach(function(r) {
        var isFull = r.white !== 'VIDE (Prendre)' && r.black !== 'VIDE (Prendre)';
        var wBtn = r.white === 'VIDE (Prendre)'
            ? '<button class="btn-join" onclick="joinPublicRoom(\''+r.id+'\')">PRENDRE BLANCS</button>'
            : '⚪ ' + esc(r.white);
        var bBtn = r.black === 'VIDE (Prendre)'
            ? '<button class="btn-join" onclick="joinPublicRoom(\''+r.id+'\')">PRENDRE NOIRS</button>'
            : '⚫ ' + esc(r.black);
        var spectBtn = isFull
            ? '<button class="btn-join" style="background:var(--purple)" onclick="joinPublicRoom(\''+r.id+'\')">👁 REGARDER</button>'
            : '';
        var specCount = r.spectators > 0 ? '<span class="spectator-count">👁 ' + r.spectators + '</span>' : '';
        c.append('<div class="room-item">'
            + '<div style="display:flex;gap:20px">'
            +   '<div><span class="room-label">Blancs</span><br><strong>' + wBtn + '</strong></div>'
            +   '<div><span class="room-label">Noirs</span><br><strong>' + bBtn + '</strong></div>'
            + '</div>'
            + '<div style="display:flex;gap:8px;align-items:center">' + specCount + spectBtn + '</div>'
            + '</div>');
    });
});

socket.on('rooms_updated', function() {
    if ($('#salons-list').is(':visible')) socket.emit('get_public_rooms');
});

socket.on('clock_sync', function(data) {
    var myTime  = myColor === 'w' ? data.w : data.b;
    var oppTime = myColor === 'w' ? data.b : data.w;
    if (isSpectator) { myTime = data.w; oppTime = data.b; }
    $('#clock-bottom').text(fmtTime(myTime));
    $('#clock-top').text(fmtTime(oppTime));

    if (data.active && data.active === (isSpectator ? 'w' : myColor)) {
        $('#player-clock-box').addClass('active').removeClass('inactive');
        $('#opponent-clock-box').removeClass('active').addClass('inactive');
    } else if (data.active) {
        $('#opponent-clock-box').addClass('active').removeClass('inactive');
        $('#player-clock-box').removeClass('active').addClass('inactive');
    } else {
        $('.clock-box').removeClass('active inactive');
    }
    var warn = !isSpectator && myTime <= 30 && myTime > 0 && data.active === myColor;
    $('#clock-bottom').toggleClass('time-warning', warn);
});

socket.on('init_game', function(data) {
    myColor = data.side || 'w';
    board.orientation(myColor === 'b' ? 'black' : 'white');
    
    // Show Joker button for all players in HvH, or only White in HvA
    if (isSpectator) {
        $('#joker-btn').addClass('hidden');
    } else if (data.mode === 'hva') {
        if (myColor === 'b') $('#joker-btn').addClass('hidden');
        else                 $('#joker-btn').removeClass('hidden');
    } else {
        // HvH: Both players can use Jokers
        $('#joker-btn').removeClass('hidden');
    }
    game.load(data.fen);
    board.position(data.fen);
    historyFens = [data.fen]; viewIndex = 0;
    movesCount = 0; gameStatus = 'playing';
    moveList = [];
    loadMoveHistory(data.move_history || []);
    $('#joker-display').text(data.jokers || 0);
    updateStatus(); updateAbortResignBtn();
    $('#nav-section').addClass('hidden');
    if (myColor === 'hva') $('#joker-container').removeClass('hidden');
});

socket.on('spectate_game', function(data) {
    isSpectator = true; myColor = 's';
    board.orientation('white');
    $('#spectator-badge').removeClass('hidden');
    $('#game-actions').addClass('hidden');
    $('#joker-btn').addClass('hidden');
    $('#player-name').text(data.white || 'Blancs');
    $('#opponent-name').text(data.black || 'Noirs');
    game.load(data.fen); board.position(data.fen);
    historyFens = [data.fen]; viewIndex = 0;
    gameStatus = 'playing'; moveList = [];
    loadMoveHistory(data.move_history || []);
    if (data.clocks) {
        $('#clock-bottom').text(fmtTime(data.clocks.w));
        $('#clock-top').text(fmtTime(data.clocks.b));
    }
    updateStatus();
});

socket.on('player_joined', function(data) {
    if (data.color !== myColor) $('#opponent-name').text(data.username).css('color', '#e17055');
    $('#status').text('⚡ Combat commencé !');
});

socket.on('board_state', function(data) {
    game.load(data.fen);
    if (historyFens[historyFens.length-1] !== data.fen) historyFens.push(data.fen);
    viewIndex = historyFens.length - 1;
    board.position(data.fen);
    movesCount = data.moves_count || 0;
    if (data.last_move) highlightLastMove(data.last_move.from, data.last_move.to);
    if (data.san) addMoveToNotation(data.san, data.color);
    // Sounds
    if (data.san) {
        if (game.in_check()) sfxCheck();
        else if (data.san.indexOf('x') !== -1) sfxCapture();
        else sfxMove();
    }
    updateStatus(); updateAbortResignBtn();
});

socket.on('joker_used', function(data) {
    game.load(data.fen);
    // Truncate the undone moves from history, then add the reverted position
    var undoSteps = data.undo_count || 2;
    historyFens = historyFens.slice(0, Math.max(1, historyFens.length - undoSteps));
    historyFens.push(data.fen);
    viewIndex = historyFens.length - 1;
    board.position(data.fen);
    $('#joker-display').text(data.remaining);
    movesCount = data.moves_count || 0;
    if (data.move_history !== undefined) loadMoveHistory(data.move_history);
    highlightLastMove(null, null);
    updateStatus(); updateAbortResignBtn();
});

socket.on('game_over', function(data) {
    gameStatus = 'finished';
    currentPGN = data.pgn || '';
    var title = 'FIN DE PARTIE', sub = '', isWin = false, isLoss = false;

    if (data.result === 'aborted') {
        title = '🚫 PARTIE ANNULÉE'; sub = 'Un joueur a annulé';
    } else if (data.result === 'resign') {
        isWin = !isSpectator && data.winner === myColor;
        isLoss = !isSpectator && data.winner !== myColor;
        title = isSpectator ? '🏳️ ABANDON' : (isWin ? '🏆 VICTOIRE !' : '🏳️ DÉFAITE');
        sub = isSpectator ? 'Un joueur a abandonné' : "L'adversaire a abandonné";
    } else if (data.result === 'timeout') {
        isWin = !isSpectator && data.winner === myColor;
        isLoss = !isSpectator && !isWin;
        title = '⏰ TEMPS ÉCOULÉ';
        sub = isSpectator ? (data.winner==='w'?'Blancs gagnent':'Noirs gagnent') : (isWin ? 'Vous gagnez !' : 'Vous perdez');
    } else if (data.result === '1-0') {
        isWin = !isSpectator && myColor === 'w';
        isLoss = !isSpectator && myColor === 'b';
        title = isSpectator ? '♟️ PARTIE TERMINÉE' : (isWin ? '🏆 VICTOIRE !' : '🏳️ DÉFAITE');
        sub = 'Échec et mat — Blancs gagnent';
    } else if (data.result === '0-1') {
        isWin = !isSpectator && myColor === 'b';
        isLoss = !isSpectator && myColor === 'w';
        title = isSpectator ? '♟️ PARTIE TERMINÉE' : (isWin ? '🏆 VICTOIRE !' : '🏳️ DÉFAITE');
        sub = 'Échec et mat — Noirs gagnent';
    } else if (data.result === '1/2-1/2') {
        title = '🤝 MATCH NUL'; sub = 'Partie nulle';
    }

    if (!isSpectator) {
        if (isWin) sfxWin();
        else if (isLoss) sfxLose();
        else if (data.result === '1/2-1/2') sfxDraw();
    }

    showResultModal(title, sub, isWin, isLoss);
    $('#nav-section').removeClass('hidden');
    data_result = data.result; // store for rematch visibility check
});

socket.on('new_chat_msg', function(data) {
    appendChatMsg(data.user, data.msg, data.user === MY_USERNAME);
    if ($('#chat-panel').hasClass('chat-collapsed')) {
        $('#chat-toggle-btn').addClass('has-new-msg');
    }
});

socket.on('rematch_offer', function(data) {
    if (isSpectator) return;
    $('#rematch-offer-text').text(esc(data.from) + ' propose une revanche !');
    $('#rematch-offer-bar').removeClass('hidden');
});

socket.on('rematch_start', function(data) {
    room = data.new_room;
    // Join the new socket room on the server
    socket.emit('join_room', { room: room });
    isSpectator = false; moveList = [];
    historyFens = []; currentPGN = '';
    gameStatus = 'playing'; movesCount = 0;
    selectedSquare = null;
    game = new Chess(); board.start();
    $('#result-modal').addClass('hidden');
    $('#nav-section').addClass('hidden');
    $('#rematch-offer-bar').addClass('hidden');
    highlightLastMove(null, null);
    renderMoveList();
    sfxMove();
});

// ─── RESULT MODAL ────────────────────────────────────────
var lastResultTitle = '';
var lastResultIsWin = false;
var lastResultIsLoss = false;

function showResultModal(title, sub, isWin, isLoss) {
    // Called with no args to re-show after review
    if (title === undefined) {
        title = lastResultTitle;
        sub = '';
        isWin = lastResultIsWin;
        isLoss = lastResultIsLoss;
    }
    lastResultTitle = title;
    lastResultIsWin = isWin;
    lastResultIsLoss = isLoss;

    var modal = $('#result-modal');
    $('#result-title').text(title);
    $('#result-subtitle').text(sub || '');
    modal.removeClass('win lose draw hidden');
    if (isWin) modal.addClass('win');
    else if (isLoss) modal.addClass('lose');
    else modal.addClass('draw');
    $('#pgn-btn').toggleClass('hidden', !currentPGN);
    $('#review-pgn-btn').toggleClass('hidden', !currentPGN);
    // Rematch shown for non-spectators when game wasn't aborted
    var showRematch = !isSpectator && data_result !== 'aborted';
    $('#rematch-btn').toggleClass('hidden', !showRematch);
    $('#review-rematch-btn').toggleClass('hidden', !showRematch);
    // Hide review bar if re-showing modal
    $('#review-bar').addClass('hidden');
}

function reviewGame() {
    // Hide modal, show review bar at bottom
    $('#result-modal').addClass('hidden');
    $('#review-bar-result').text(lastResultTitle);
    $('#review-pgn-btn').toggleClass('hidden', !currentPGN);
    $('#review-bar').removeClass('hidden');
    // Jump to last move so user can navigate from end
    navMove('end');
}
// data_result is set inside the main game_over handler above
var data_result = '';

function downloadPGN() {
    if (!currentPGN) return;
    var a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([currentPGN], {type:'text/plain'}));
    a.download = 'chess_' + room + '.pgn'; a.click();
    URL.revokeObjectURL(a.href);
}
function requestRematch() {
    if (isLocalMode) {
        // Restart local game directly
        if (localClockInterval) { clearInterval(localClockInterval); localClockInterval = null; }
        game = new Chess(); board.start();
        board.orientation('white');
        historyFens = [game.fen()]; viewIndex = 0;
        movesCount = 0; moveList = []; selectedSquare = null;
        gameStatus = 'playing'; currentPGN = '';
        var baseTime = parseInt($('#base-time').val()) * 60;
        localClocks = { w: baseTime, b: baseTime, active: null };
        $('#clock-bottom').text(fmtTime(baseTime));
        $('#clock-top').text(fmtTime(baseTime));
        $('#result-modal').addClass('hidden');
        $('#nav-section').addClass('hidden');
        highlightLastMove(null, null);
        renderMoveList(); updateStatus(); sfxMove();
        return;
    }
    socket.emit('request_rematch', { room: room });
    $('#rematch-btn').text('⏳ En attente...').prop('disabled', true);
}
function acceptRematch() {
    socket.emit('accept_rematch', { room: room });
    $('#rematch-offer-bar').addClass('hidden');
}
function goToLobby() { location.reload(); }

// ─── GAME LOGIC ──────────────────────────────────────────
function handleSquareInteraction(square) {
    if (isSpectator || viewIndex !== historyFens.length - 1 || game.game_over() || gameStatus !== 'playing') return;
    var currentTurn = game.turn();
    var piece = game.get(square);

    if (isLocalMode) {
        // Local mode: the active player is always game.turn()
        var isCurrentPiece = piece && piece.color === currentTurn;
        if (!selectedSquare) {
            if (isCurrentPiece) { selectedSquare = square; highlightPossibleMoves(square); }
            return;
        }
        if (selectedSquare === square) { selectedSquare = null; removeHighlights(); return; }
        if (isCurrentPiece) { selectedSquare = square; removeHighlights(); highlightPossibleMoves(square); return; }
        var mv = game.move({ from: selectedSquare, to: square, promotion: 'q' });
        if (mv) {
            removeHighlights(); selectedSquare = null;
            handleLocalMove(mv, currentTurn);
        } else { selectedSquare = null; removeHighlights(); }
    } else {
        // Online mode (HvA / HvH)
        var isAlly = piece && piece.color === myColor;
        if (!selectedSquare) {
            if (isAlly && currentTurn === myColor) { selectedSquare = square; highlightPossibleMoves(square); }
            return;
        }
        if (selectedSquare === square) { selectedSquare = null; removeHighlights(); return; }
        if (isAlly) { selectedSquare = square; removeHighlights(); highlightPossibleMoves(square); return; }
        var mv = game.move({ from: selectedSquare, to: square, promotion: 'q' });
        if (mv) {
            removeHighlights();
            socket.emit('move', { move: selectedSquare + square + (mv.promotion ? 'q' : ''), room: room });
            selectedSquare = null;
        } else { selectedSquare = null; removeHighlights(); }
    }
}

function handleLocalMove(mv, colorPlayed) {
    movesCount++;
    var san = mv.san;
    var fromSq = mv.from, toSq = mv.to;
    addMoveToNotation(san, colorPlayed);
    historyFens.push(game.fen());
    viewIndex = historyFens.length - 1;
    board.position(game.fen());
    highlightLastMove(fromSq, toSq);

    // Sounds
    if (game.in_check()) sfxCheck();
    else if (san.indexOf('x') !== -1) sfxCapture();
    else sfxMove();

    // Clock management
    var inc = parseInt($('#inc-time').val()) || 0;
    if (localClocks.active) localClocks[colorPlayed] += inc;
    localClocks.active = game.turn();
    localClocks.lastTick = Date.now();
    // Start clock interval if not already running
    if (!localClockInterval) {
        localClockInterval = setInterval(tickLocalClock, 1000);
    }

    updateStatus(); updateAbortResignBtn();

    // Auto-flip with animation
    if (autoFlipEnabled) {
        var nextOrientation = game.turn() === 'w' ? 'white' : 'black';
        if (board.orientation() !== nextOrientation) {
            $('#board').css('transform', 'rotateY(90deg)');
            setTimeout(function() {
                board.orientation(nextOrientation);
                $('#board').css('transform', 'rotateY(0deg)');
            }, 650);
        }
    }

    // Check game over
    if (game.game_over()) {
        clearInterval(localClockInterval); localClockInterval = null;
        gameStatus = 'finished';
        var title, sub, isWin = false, isLoss = false;
        if (game.in_checkmate()) {
            var winner = colorPlayed === 'w' ? 'Blancs' : 'Noirs';
            title = '💀 Échec et Mat !'; sub = winner + ' gagnent';
        } else {
            title = '🤝 Match Nul'; sub = 'Partie nulle';
        }
        showResultModal(title, sub, false, false);
        $('#nav-section').removeClass('hidden');
        data_result = game.result();
    }
}

function tickLocalClock() {
    if (gameStatus !== 'playing' || !localClocks.active) return;
    var now = Date.now();
    var elapsed = (now - localClocks.lastTick) / 1000;
    localClocks[localClocks.active] -= elapsed;
    localClocks.lastTick = now;
    if (localClocks[localClocks.active] <= 0) {
        localClocks[localClocks.active] = 0;
        clearInterval(localClockInterval); localClockInterval = null;
        gameStatus = 'finished';
        var loser = localClocks.active;
        var winner = loser === 'w' ? 'Noirs' : 'Blancs';
        showResultModal('⏰ TEMPS ÉCOULÉ', winner + ' gagnent', false, false);
        $('#nav-section').removeClass('hidden');
        data_result = 'timeout';
    }
    // Update clock displays — in local mode, top=Noirs, bottom=Blancs
    var orient = board.orientation();
    if (orient === 'white') {
        $('#clock-bottom').text(fmtTime(localClocks.w));
        $('#clock-top').text(fmtTime(localClocks.b));
    } else {
        $('#clock-bottom').text(fmtTime(localClocks.b));
        $('#clock-top').text(fmtTime(localClocks.w));
    }
    var warn = localClocks[localClocks.active] <= 30;
    if (orient === 'white') {
        $('#clock-bottom').toggleClass('time-warning', localClocks.active === 'w' && warn);
        $('#clock-top').toggleClass('time-warning', localClocks.active === 'b' && warn);
    } else {
        $('#clock-bottom').toggleClass('time-warning', localClocks.active === 'b' && warn);
        $('#clock-top').toggleClass('time-warning', localClocks.active === 'w' && warn);
    }
}
function removeHighlights() {
    $('#board .square-55d63').removeClass('highlight-selected highlight-hint');
    $('#board .piece-55d63').removeClass('selected-anim');
}
function highlightPossibleMoves(sq) {
    var moves = game.moves({ square: sq, verbose: true });
    if (!moves.length) return;
    $('#board .square-' + sq).addClass('highlight-selected');
    $('#board .square-' + sq + ' .piece-55d63').addClass('selected-anim');
    if (assistEnabled) moves.forEach(function(m) { $('#board .square-' + m.to).addClass('highlight-hint'); });
}
function toggleAssist() {
    assistEnabled = !assistEnabled; updateAssistUI(); removeHighlights();
}
function updateAssistUI() {
    $('#toggle-assist-game').text('💡 AIDE : ' + (assistEnabled ? 'ON' : 'OFF'))
        .css('background', assistEnabled ? 'var(--blue)' : '#555');
}
function useJoker() {
    if (isSpectator || viewIndex !== historyFens.length - 1 || gameStatus !== 'playing') return;
    if (isLocalMode) {
        handleLocalUndo();
    } else {
        socket.emit('use_joker', { room: room });
    }
}
function handleLocalUndo() {
    if (localJokers <= 0) return;
    var res = game.undo();
    if (!res) return;

    localJokers--;
    $('#joker-display').text(localJokers);
    
    movesCount = Math.max(0, movesCount - 1);
    historyFens.pop();
    viewIndex = historyFens.length - 1;
    board.position(game.fen());
    
    // Switch clocks back to whoever just "undid" their last move (current turn)
    localClocks.active = game.turn();
    localClocks.lastTick = Date.now();
    
    // Remove last move from notation
    moveList.pop();
    renderMoveList();

    // Auto-flip if enabled
    if (autoFlipEnabled) {
        board.orientation(game.turn() === 'w' ? 'white' : 'black');
    }

    updateStatus(); sfxMove(); highlightLastMove(null, null);
}
function navMove(type) {
    if (type === 'start') viewIndex = 0;
    if (type === 'prev'  && viewIndex > 0) viewIndex--;
    if (type === 'next'  && viewIndex < historyFens.length - 1) viewIndex++;
    if (type === 'end')  viewIndex = historyFens.length - 1;
    board.position(historyFens[viewIndex]);
    var live = viewIndex === historyFens.length - 1;
    $('#status').text(live ? '🎮 En direct' : '👀 Historique (' + viewIndex + '/' + (historyFens.length-1) + ')');
}

function updateStatus() {
    var col = game.turn() === 'w' ? 'Blancs' : 'Noirs';
    var s = 'Tour : ' + col;
    if (game.in_checkmate()) s = '💀 Échec et Mat !';
    else if (game.in_draw())  s = '🤝 Partie Nulle';
    else if (game.in_check()) s = '⚠️ ÉCHEC (' + col + ')';
    $('#status').text(s);
}
function updateAbortResignBtn() {
    var btn = $('#abort-resign-btn');
    if (movesCount < 2) btn.text('🚫 ANNULER (ABORT)').css('background', '#636e72');
    else                btn.text('🏳️ ABANDONNER').css('background', 'var(--danger)');
}
function abortOrResign() {
    if (isSpectator) return;
    var action = movesCount < 2 ? 'ANNULER' : 'ABANDONNER';
    if (confirm('Voulez-vous vraiment ' + action + ' la partie ?')) {
        if (isLocalMode) {
            if (localClockInterval) { clearInterval(localClockInterval); localClockInterval = null; }
            gameStatus = 'finished';
            if (movesCount < 2) {
                showResultModal('🚫 PARTIE ANNULÉE', '', false, false);
            } else {
                showResultModal('🏳️ ABANDON', 'Partie terminée', false, false);
            }
            $('#nav-section').removeClass('hidden');
            data_result = 'aborted';
        } else {
            socket.emit('abort_resign', { room: room });
        }
    }
}
function confirmExit() {
    if (isLocalMode && localClockInterval) { clearInterval(localClockInterval); localClockInterval = null; }
    if (gameStatus === 'playing') {
        if (confirm('La partie est en cours. Quitter ?')) location.reload();
    } else location.reload();
}
function fmtTime(s) {
    if (s < 0) s = 0;
    var m = Math.floor(s / 60), sec = Math.floor(s % 60);
    return (m<10?'0':'') + m + ':' + (sec<10?'0':'') + sec;
}

// ─── BOARD INIT ──────────────────────────────────────────
board = Chessboard('board', {
    draggable: true,
    position: 'start',
    pieceTheme: '/static/img/chesspieces/wikipedia/{piece}.png',
    onDragStart: function(s, p) {
        if (isSpectator || viewIndex !== historyFens.length-1 || gameStatus !== 'playing' || game.game_over()) return false;
        if (isLocalMode) {
            // In local mode, allow dragging only current turn's pieces
            var turn = game.turn();
            return (turn === 'w' && p.search(/^w/) !== -1) || (turn === 'b' && p.search(/^b/) !== -1);
        }
        return p.search(myColor) !== -1;
    },
    onDrop: function(s, t) {
        if (isSpectator) return 'snapback';
        var currentTurn = game.turn();
        var mv = game.move({ from: s, to: t, promotion: 'q' });
        if (!mv) return 'snapback';
        if (isLocalMode) {
            handleLocalMove(mv, currentTurn);
        } else {
            socket.emit('move', { move: s + t + (mv.promotion ? 'q' : ''), room: room });
        }
        removeHighlights(); selectedSquare = null;
    },
    onSnapEnd: function() { board.position(game.fen()); }
});

var lastSqInteraction = 0;
$('#board').on('mousedown touchstart', function(e) {
    if (isSpectator || viewIndex !== historyFens.length - 1 || game.game_over() || gameStatus !== 'playing') return;
    
    var now = Date.now();
    if (now - lastSqInteraction < 100) return;
    lastSqInteraction = now;

    var offset = $(this).offset();
    var width = $(this).width();
    var sqSize = width / 8;
    
    var pageX = e.type.includes('touch') ? e.originalEvent.changedTouches[0].pageX : e.pageX;
    var pageY = e.type.includes('touch') ? e.originalEvent.changedTouches[0].pageY : e.pageY;
    
    var x = pageX - offset.left;
    var y = pageY - offset.top;
    
    // Check boundaries
    if (x < 0 || x >= width || y < 0 || y >= width) return;
    
    var fileNum = Math.floor(x / sqSize);
    var rankNum = 7 - Math.floor(y / sqSize); // default white orientation
    
    if (board.orientation() === 'black') {
        fileNum = 7 - fileNum;
        rankNum = 7 - rankNum;
    }
    
    var files = 'abcdefgh';
    var sq = files[fileNum] + (rankNum + 1);
    
    handleSquareInteraction(sq);
});
