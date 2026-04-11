from flask import Flask, render_template, request, session, redirect, url_for, jsonify, Response
from flask_socketio import SocketIO, emit, join_room
import chess
import chess.pgn
import chess.engine
import os, time, socket, sqlite3, io, random, string

app = Flask(__name__)
app.config['SECRET_KEY'] = os.environ.get('SECRET_KEY', 'chess_arena_dev_key_change_me_in_prod')
socketio = SocketIO(app, cors_allowed_origins="*", async_mode='threading')

STOCKFISH_PATH = os.environ.get('STOCKFISH_PATH', '/usr/games/stockfish')
DB_PATH = os.path.join(os.path.dirname(__file__), "chess_arena.db")

# ─── DATABASE ───────────────────────────────────────────────────────────────

def get_db():
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    return conn

def init_db():
    conn = get_db(); c = conn.cursor()
    c.execute('''CREATE TABLE IF NOT EXISTS users
                 (id INTEGER PRIMARY KEY AUTOINCREMENT,
                  username TEXT UNIQUE NOT NULL,
                  wins INTEGER DEFAULT 0,
                  losses INTEGER DEFAULT 0,
                  draws INTEGER DEFAULT 0)''')
    # Non-destructive migrations for existing DBs
    for col, typ in [('losses', 'INTEGER DEFAULT 0'), ('draws', 'INTEGER DEFAULT 0')]:
        try: c.execute(f"ALTER TABLE users ADD COLUMN {col} {typ}")
        except: pass
    c.execute('''CREATE TABLE IF NOT EXISTS games_history
                 (id INTEGER PRIMARY KEY AUTOINCREMENT,
                  room_id TEXT NOT NULL,
                  white TEXT, black TEXT,
                  result TEXT, pgn TEXT,
                  played_at DATETIME DEFAULT CURRENT_TIMESTAMP)''')
    conn.commit(); conn.close()

init_db()

# ─── HELPERS ─────────────────────────────────────────────────────────────────

def get_best_ip():
    ips = []
    try:
        hostname = socket.gethostname()
        for info in socket.getaddrinfo(hostname, None):
            ip = info[4][0]
            if "." in ip and ip != "127.0.0.1": ips.append(ip)
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        s.connect(("8.8.8.8", 80)); ips.append(s.getsockname()[0]); s.close()
    except: pass
    if "10.42.0.1" in ips: return "10.42.0.1"
    for ip in ips:
        if ip.startswith("10.2."): return ip
    for ip in ips:
        if ip.startswith("10."): return ip
    for ip in ips:
        if ip.startswith("192.168."): return ip
    return ips[0] if ips else "127.0.0.1"

def get_ai_move(board, level):
    """
    Difficulty tiers:
      1-2  : Random legal move  (truly beatable for beginners)
      3-6  : Stockfish depth 1-4 (limited lookahead)
      7-10 : Stockfish time 0.1-0.8s (increasingly strong)
    """
    import random
    legal = list(board.legal_moves)
    if not legal:
        return None

    # Levels 1-2: purely random
    if level <= 2:
        return random.choice(legal)

    engine = None
    try:
        if not os.path.exists(STOCKFISH_PATH):
            return random.choice(legal)  # fallback if Stockfish missing
        engine = chess.engine.SimpleEngine.popen_uci(STOCKFISH_PATH)
        if level <= 6:
            # Depth 1 at level 3, up to depth 4 at level 6
            limit = chess.engine.Limit(depth=level - 2)
        else:
            # Time 0.1s at level 7, up to 0.8s at level 10
            limit = chess.engine.Limit(time=0.1 * (level - 6))
        result = engine.play(board, limit)
        return result.move
    except:
        return random.choice(legal)
    finally:
        if engine: engine.quit()

def make_room_id():
    return "duel_" + ''.join(random.choices(string.ascii_lowercase + string.digits, k=9))

def generate_pgn(game_data, result_str):
    g = chess.pgn.Game()
    g.headers["Event"] = "Chess Arena Pro - LAN"
    g.headers["White"] = game_data['players']['w'] or "?"
    g.headers["Black"] = game_data['players']['b'] or "?"
    g.headers["Result"] = result_str
    board = chess.Board()
    node = g
    for move in game_data['board'].move_stack:
        node = node.add_variation(move)
    buf = io.StringIO()
    g.accept(chess.pgn.FileExporter(buf))
    return buf.getvalue()

def save_game_result(room, result):
    """Persist HvH game to DB and update player W/L/D stats."""
    if room not in games: return
    game = games[room]
    if game['mode'] != 'hvh': return
    white = game['players']['w']; black = game['players']['b']
    if not white or not black: return

    pgn_result = result if result in ('1-0', '0-1', '1/2-1/2') else '*'
    pgn_str = generate_pgn(game, pgn_result)

    conn = get_db(); c = conn.cursor()
    c.execute("INSERT INTO games_history (room_id, white, black, result, pgn) VALUES (?,?,?,?,?)",
              (room, white, black, result, pgn_str))
    if result == '1-0':
        c.execute("UPDATE users SET wins=wins+1 WHERE username=?", (white,))
        c.execute("UPDATE users SET losses=losses+1 WHERE username=?", (black,))
    elif result == '0-1':
        c.execute("UPDATE users SET wins=wins+1 WHERE username=?", (black,))
        c.execute("UPDATE users SET losses=losses+1 WHERE username=?", (white,))
    elif result == '1/2-1/2':
        c.execute("UPDATE users SET draws=draws+1 WHERE username=?", (white,))
        c.execute("UPDATE users SET draws=draws+1 WHERE username=?", (black,))
    conn.commit(); conn.close()

# ─── GAME STATE ──────────────────────────────────────────────────────────────

games = {}
player_sessions = {}

def new_game_state(mode, username, level, base, inc):
    return {
        'board': chess.Board(), 'mode': mode, 'level': level,
        'players': {'w': username, 'b': None},
        'players_online': {'w': True, 'b': (mode == 'hva')},
        'disconnect_timers': {'w': None, 'b': None},
        'spectators': set(),
        'moves_count': 0, 'start_time': time.time(),
        'ai_color': 'b' if mode == 'hva' else None,
        'jokers': 3,
        'config': {'base': base, 'inc': inc},
        'clocks': {'w': float(base), 'b': float(base), 'active': None, 'last_tick': time.time()},
        'status': 'playing',
        'move_history': [],  # [{san, from, to, color}, ...]
        'rematch_votes': set(),
    }

# ─── BACKGROUND TASKS ────────────────────────────────────────────────────────

def clock_manager():
    while True:
        socketio.sleep(1)
        now = time.time()
        for rid in list(games.keys()):
            g = games[rid]
            if g['status'] == 'finished': continue
            if g['clocks']['active']:
                color = g['clocks']['active']
                elapsed = now - g['clocks']['last_tick']
                g['clocks'][color] -= elapsed
                g['clocks']['last_tick'] = now
                if g['clocks'][color] <= 0:
                    g['clocks'][color] = 0
                    g['status'] = 'finished'
                    winner = 'b' if color == 'w' else 'w'
                    result = '0-1' if color == 'w' else '1-0'
                    pgn = generate_pgn(g, result) if g['mode'] == 'hvh' else ''
                    save_game_result(rid, result)
                    socketio.emit('game_over', {'result': 'timeout', 'winner': winner, 'pgn': pgn}, to=rid)
                    continue
            if (not g['players_online']['w'] and not g['players_online']['b'] and g['mode'] == 'hvh'):
                if all(g['disconnect_timers'][c] and (now - g['disconnect_timers'][c] > 30) for c in ['w', 'b']):
                    del games[rid]; continue
            socketio.emit('clock_sync', {
                'w': max(0, round(g['clocks']['w'])),
                'b': max(0, round(g['clocks']['b'])),
                'active': g['clocks']['active']
            }, to=rid)

socketio.start_background_task(clock_manager)

def ai_turn_manager(room):
    time.sleep(0.5)
    if room not in games: return
    game = games[room]
    if game['board'].is_game_over() or game['status'] != 'playing': return
    current_turn = 'w' if game['board'].turn == chess.WHITE else 'b'
    if game['mode'] == 'hva' and current_turn == game['ai_color']:
        move = get_ai_move(game['board'], game['level'])
        if move:
            color = game['ai_color']
            game['clocks'][color] += game['config']['inc']
            san = game['board'].san(move)
            game['board'].push(move)
            game['moves_count'] += 1
            entry = {'san': san, 'from': str(move)[:2], 'to': str(move)[2:4], 'color': color}
            game['move_history'].append(entry)
            game['clocks']['active'] = 'w' if color == 'b' else 'b'
            game['clocks']['last_tick'] = time.time()
            socketio.emit('board_state', {
                'fen': game['board'].fen(), 'moves_count': game['moves_count'],
                'last_move': {'from': entry['from'], 'to': entry['to']},
                'san': san, 'color': color
            }, to=room)
            if game['board'].is_game_over():
                result = game['board'].result()
                game['status'] = 'finished'
                socketio.emit('game_over', {'result': result, 'pgn': ''}, to=room)

# ─── ROUTES ──────────────────────────────────────────────────────────────────

@app.route('/')
def index():
    if 'username' not in session: return redirect(url_for('login'))
    return render_template('index.html', local_ip=get_best_ip(), username=session['username'])

@app.route('/login', methods=['GET', 'POST'])
def login():
    if request.method == 'POST':
        username = request.form.get('username', '').strip()
        if username:
            session['username'] = username
            conn = get_db(); c = conn.cursor()
            c.execute("INSERT OR IGNORE INTO users (username) VALUES (?)", (username,))
            conn.commit(); conn.close()
            return redirect(url_for('index'))
    return render_template('login.html')

@app.route('/logout')
def logout():
    session.pop('username', None); return redirect(url_for('login'))

@app.route('/api/leaderboard')
def leaderboard():
    conn = get_db(); c = conn.cursor()
    c.execute("SELECT username, wins, losses, draws FROM users ORDER BY wins DESC, losses ASC LIMIT 10")
    rows = [dict(r) for r in c.fetchall()]
    conn.close()
    return jsonify(rows)

@app.route('/api/pgn/<room_id>')
def get_pgn_file(room_id):
    conn = get_db(); c = conn.cursor()
    c.execute("SELECT pgn FROM games_history WHERE room_id=? ORDER BY played_at DESC LIMIT 1", (room_id,))
    row = c.fetchone(); conn.close()
    if row and row['pgn']:
        return Response(row['pgn'], mimetype='text/plain',
                        headers={'Content-Disposition': f'attachment; filename=chess_{room_id}.pgn'})
    return jsonify({'error': 'not found'}), 404

# ─── SOCKET EVENTS ───────────────────────────────────────────────────────────

@socketio.on('disconnect')
def on_disconnect():
    if request.sid not in player_sessions: return
    info = player_sessions.pop(request.sid)
    room = info['room']; color = info['color']
    if room not in games: return
    if color == 's':
        games[room].get('spectators', set()).discard(request.sid)
    else:
        # Don't clear the player name — allow reconnection
        games[room]['players_online'][color] = False
        games[room]['disconnect_timers'][color] = time.time()
        socketio.emit('player_status', {'color': color, 'online': False}, to=room)
        socketio.emit('rooms_updated')

@socketio.on('get_public_rooms')
def list_rooms():
    public_list = []
    for rid, g in games.items():
        if g['mode'] == 'hvh' and g['status'] == 'playing':
            public_list.append({
                'id': rid,
                'white': g['players']['w'] or "VIDE (Prendre)",
                'black': g['players']['b'] or "VIDE (Prendre)",
                'spectators': len(g.get('spectators', set()))
            })
    emit('rooms_list', public_list)

@socketio.on('create_room')
def on_create(data):
    room = data['room']; mode = data['mode']
    username = session.get('username', 'Anonyme')
    base = int(data.get('time', 10)) * 60; inc = int(data.get('inc', 5))
    games[room] = new_game_state(mode, username, int(data.get('level', 1)), base, inc)
    join_room(room)
    player_sessions[request.sid] = {'room': room, 'color': 'w'}
    emit('init_game', {'fen': games[room]['board'].fen(), 'side': 'w', 'mode': mode,
                       'jokers': games[room]['jokers'], 'move_history': []})
    socketio.emit('rooms_updated')

@socketio.on('join_room')
def on_join(data):
    room = data['room']; username = session.get('username', 'Anonyme')
    if room not in games: return
    game = games[room]
    target_color = None
    if not game['players']['b']: target_color = 'b'
    elif not game['players']['w']: target_color = 'w'

    if target_color:
        game['players'][target_color] = username
        game['players_online'][target_color] = True
        game['disconnect_timers'][target_color] = None
        join_room(room)
        player_sessions[request.sid] = {'room': room, 'color': target_color}
        emit('init_game', {'fen': game['board'].fen(), 'side': target_color, 'mode': game['mode'],
                           'jokers': game['jokers'], 'move_history': game['move_history']})
        socketio.emit('player_joined', {'username': username, 'color': target_color}, to=room)
        socketio.emit('rooms_updated')
    else:
        # Room full — join as spectator
        join_room(room)
        player_sessions[request.sid] = {'room': room, 'color': 's'}
        game.setdefault('spectators', set()).add(request.sid)
        emit('spectate_game', {
            'fen': game['board'].fen(),
            'white': game['players']['w'], 'black': game['players']['b'],
            'move_history': game['move_history'],
            'clocks': {'w': round(game['clocks']['w']),
                       'b': round(game['clocks']['b']),
                       'active': game['clocks']['active']}
        })

@socketio.on('move')
def handle_move(data):
    room = data['room']
    if room not in games or games[room]['status'] != 'playing': return
    game = games[room]; board = game['board']
    color = player_sessions.get(request.sid, {}).get('color')
    if color == 's': return  # Spectators cannot move
    try:
        move = chess.Move.from_uci(data['move'])
        if move not in board.legal_moves: return
        c = 'w' if board.turn == chess.WHITE else 'b'
        if color != c: return  # Not your turn!
        san = board.san(move)
        board.push(move); game['moves_count'] += 1
        # Apply time increment AFTER the move
        if game['clocks']['active']: game['clocks'][c] += game['config']['inc']
        entry = {'san': san, 'from': str(move)[:2], 'to': str(move)[2:4], 'color': c}
        game['move_history'].append(entry)
        game['clocks']['active'] = 'b' if board.turn == chess.BLACK else 'w'
        game['clocks']['last_tick'] = time.time()
        socketio.emit('board_state', {
            'fen': board.fen(), 'moves_count': game['moves_count'],
            'last_move': {'from': entry['from'], 'to': entry['to']},
            'san': san, 'color': c
        }, to=room)
        if board.is_game_over():
            result = board.result()
            game['status'] = 'finished'
            pgn = generate_pgn(game, result) if game['mode'] == 'hvh' else ''
            save_game_result(room, result)
            socketio.emit('game_over', {'result': result, 'pgn': pgn}, to=room)
        elif game['mode'] == 'hva':
            socketio.start_background_task(ai_turn_manager, room)
    except Exception as e:
        print(f'[MOVE ERROR] room={room} error={e}')

@socketio.on('abort_resign')
def handle_abort_resign(data):
    room = data['room']
    if room not in games or games[room]['status'] != 'playing': return
    game = games[room]
    color = player_sessions.get(request.sid, {}).get('color')
    if not color or color == 's': return
    game['status'] = 'finished'
    if game['moves_count'] < 2:
        socketio.emit('game_over', {'result': 'aborted', 'pgn': ''}, to=room)
    else:
        winner = 'b' if color == 'w' else 'w'
        result = '0-1' if color == 'w' else '1-0'
        pgn = generate_pgn(game, result) if game['mode'] == 'hvh' else ''
        save_game_result(room, result)
        socketio.emit('game_over', {'result': 'resign', 'winner': winner, 'pgn': pgn}, to=room)

@socketio.on('use_joker')
def handle_joker(data):
    room = data['room']
    if room not in games or games[room]['jokers'] <= 0 or games[room]['status'] != 'playing': return
    game = games[room]; board = game['board']
    steps = 2 if game['mode'] == 'hva' else 1
    actual_undone = 0
    for _ in range(steps):
        if len(board.move_stack) > 0:
            board.pop()
            game['moves_count'] = max(0, game['moves_count'] - 1)
            if game['move_history']: game['move_history'].pop()
            actual_undone += 1
    game['jokers'] -= 1
    emit('joker_used', {
        'fen': board.fen(), 'remaining': game['jokers'],
        'moves_count': game['moves_count'], 'move_history': game['move_history'],
        'undo_count': actual_undone
    }, to=room)

@socketio.on('chat_msg')
def handle_chat(data):
    room = data.get('room')
    if not room or room not in games: return
    username = session.get('username', 'Anonyme')
    msg = str(data.get('msg', '')).strip()[:200]
    if not msg: return
    socketio.emit('new_chat_msg', {'user': username, 'msg': msg}, to=room)

@socketio.on('request_rematch')
def handle_rematch_request(data):
    room = data.get('room')
    if room not in games: return
    color = player_sessions.get(request.sid, {}).get('color')
    if not color or color == 's': return
    username = session.get('username', 'Anonyme')
    game = games[room]
    # HvA: AI cannot vote, auto-accept immediately
    if game['mode'] == 'hva':
        _do_rematch(room, game)
        return
    game['rematch_votes'].add(color)
    # Notify the other player
    socketio.emit('rematch_offer', {'from': username, 'color': color}, to=room)
    # If both voted, start rematch automatically
    if 'w' in game['rematch_votes'] and 'b' in game['rematch_votes']:
        _do_rematch(room, game)

@socketio.on('accept_rematch')
def handle_accept_rematch(data):
    room = data.get('room')
    if room not in games: return
    color = player_sessions.get(request.sid, {}).get('color')
    if not color or color == 's': return
    game = games[room]
    game['rematch_votes'].add(color)
    if 'w' in game['rematch_votes'] and 'b' in game['rematch_votes']:
        _do_rematch(room, game)

def _do_rematch(old_room, old_game):
    new_room = make_room_id()
    if old_game['mode'] == 'hva':
        human = old_game['players']['w']
        games[new_room] = new_game_state(
            'hva', human, old_game['level'],
            old_game['config']['base'], old_game['config']['inc']
        )
    else:
        games[new_room] = new_game_state(
            'hvh',
            old_game['players']['b'],  # old black becomes new white
            old_game['level'],
            old_game['config']['base'],
            old_game['config']['inc']
        )
        games[new_room]['players']['b'] = old_game['players']['w']
        games[new_room]['players_online']['b'] = True

    # Migrate all player sessions from old room to new room
    for sid, info in list(player_sessions.items()):
        if info['room'] == old_room and info['color'] != 's':
            old_color = info['color']
            if old_game['mode'] == 'hva':
                new_color = old_color  # same color in HvA
            else:
                new_color = 'b' if old_color == 'w' else 'w'  # swap colors
            player_sessions[sid] = {'room': new_room, 'color': new_color}
            # Join new socket room
            join_room(new_room, sid=sid)

    socketio.emit('rematch_start', {'new_room': new_room}, to=old_room)

if __name__ == '__main__':
    socketio.run(app, host='0.0.0.0', port=5000, debug=True)
