from flask import Flask, render_template, request, session, redirect, url_for
from flask_socketio import SocketIO, emit, join_room
import chess
import chess.engine
import os
import time
import socket
import sqlite3

app = Flask(__name__)
app.config['SECRET_KEY'] = 'chess_secret_key_12345'
# Utilisation de threading pour plus de simplicité sur Kali
socketio = SocketIO(app, cors_allowed_origins="*", async_mode='threading')

STOCKFISH_PATH = "/usr/games/stockfish"
DB_PATH = "chess_arena.db"

# --- INITIALISATION BASE DE DONNÉES (SQLite) ---
def init_db():
    conn = sqlite3.connect(DB_PATH)
    c = conn.cursor()
    c.execute('''CREATE TABLE IF NOT EXISTS users 
                 (id INTEGER PRIMARY KEY AUTOINCREMENT, 
                  username TEXT UNIQUE NOT NULL, 
                  wins INTEGER DEFAULT 0)''')
    conn.commit()
    conn.close()

init_db()

# --- GESTION RÉSEAU (IP Prioritaire) ---
def get_best_ip():
    """Détecte l'IP en privilégiant le Point d'accès (10.42.0.1) et le Campus (10.2)."""
    ips = []
    try:
        # Méthode 1 : Scan des interfaces
        hostname = socket.gethostname()
        for info in socket.getaddrinfo(hostname, None):
            ip = info[4][0]
            if "." in ip and ip != "127.0.0.1":
                ips.append(ip)
        
        # Méthode 2 : Connexion fictive
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        s.connect(("8.8.8.8", 80))
        ips.append(s.getsockname()[0])
        s.close()
    except: pass

    # --- TRI PAR PRIORITÉ ---
    # 1. Ton Point d'accès actuel
    if "10.42.0.1" in ips: return "10.42.0.1"
    # 2. Réseau Campus
    for ip in ips:
        if ip.startswith("10.2."): return ip
    # 3. Autre réseau local 10.x
    for ip in ips:
        if ip.startswith("10."): return ip
    # 4. Standard Maison
    for ip in ips:
        if ip.startswith("192.168."): return ip

    return ips[0] if ips else "127.0.0.1"

# --- LOGIQUE IA ---
def get_ai_move(board, level):
    engine = None
    try:
        if not os.path.exists(STOCKFISH_PATH): return None
        engine = chess.engine.SimpleEngine.popen_uci(STOCKFISH_PATH)
        if level <= 3:
            engine.configure({"Skill Level": 0})
            limit = chess.engine.Limit(time=0.05, depth=1)
        else:
            skill_level = (level - 1) * 2 
            engine.configure({"Skill Level": skill_level})
            limit = chess.engine.Limit(time=0.1 * level)
        result = engine.play(board, limit)
        return result.move
    except: return None
    finally:
        if engine: engine.quit()

# --- ÉTAT DES SALONS ---
# Structure enrichie pour gestion compétitive
games = {}
# Mapping SID -> (room, color)
player_sessions = {}

def clock_manager():
    """Gestionnaire central des temps (Horloges + Timers AFK/Abort)."""
    while True:
        socketio.sleep(1)
        now = time.time()
        for rid in list(games.keys()):
            g = games[rid]
            if g['status'] == 'finished': continue

            # 1. GESTION DES HORLOGES DE JEU
            if g['clocks']['active']:
                color = g['clocks']['active']
                elapsed = now - g['clocks']['last_tick']
                g['clocks'][color] -= elapsed
                g['clocks']['last_tick'] = now
                
                if g['clocks'][color] <= 0:
                    g['clocks'][color] = 0
                    g['status'] = 'finished'
                    g['clocks']['active'] = None
                    socketio.emit('game_over', {'result': 'timeout', 'winner': 'b' if color == 'w' else 'w'}, to=rid)
            
            # 2. TIMER PREMIER COUP (Abort automatique)
            if g['moves_count'] < 2 and g['mode'] == 'hvh':
                elapsed_since_start = now - g['start_time']
                limit = 60 # 60 sec pour le premier coup
                if elapsed_since_start > limit:
                    g['status'] = 'finished'
                    socketio.emit('game_over', {'result': 'aborted', 'reason': 'first_move_timeout'}, to=rid)
                    # On ne supprime pas tout de suite pour laisser l'UI afficher le message

            # 3. GESTION DÉCONNEXION (Forfait après 5 min)
            for color in ['w', 'b']:
                if not g['players_online'][color] and g['players'][color]:
                    if g['disconnect_timers'][color] is None:
                        g['disconnect_timers'][color] = now
                    
                    elapsed_dc = now - g['disconnect_timers'][color]
                    if elapsed_dc >= 300: # 5 minutes
                        g['status'] = 'finished'
                        winner = 'b' if color == 'w' else 'w'
                        socketio.emit('game_over', {'result': 'abandon', 'winner': winner}, to=rid)
                else:
                    g['disconnect_timers'][color] = None

            # 4. DOUBLE DÉCONNEXION (Fermeture salon)
            if not g['players_online']['w'] and not g['players_online']['b'] and g['mode'] == 'hvh':
                # Si personne n'est revenu après 15 sec, on ferme
                if all(g['disconnect_timers'][c] and (now - g['disconnect_timers'][c] > 15) for c in ['w', 'b']):
                    del games[rid]
                    continue

            # Sync horloges et timers de déconnexion
            dc_remaining = {
                'w': max(0, 300 - int(now - g['disconnect_timers']['w'])) if g['disconnect_timers']['w'] else None,
                'b': max(0, 300 - int(now - g['disconnect_timers']['b'])) if g['disconnect_timers']['b'] else None
            }
            
            socketio.emit('clock_sync', {
                'w': max(0, round(g['clocks']['w'])),
                'b': max(0, round(g['clocks']['b'])),
                'active': g['clocks']['active'],
                'dc_remaining': dc_remaining
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
            game['board'].push(move)
            game['moves_count'] += 1
            game['clocks']['active'] = 'w' if color == 'b' else 'b'
            game['clocks']['last_tick'] = time.time()
            
            socketio.emit('board_state', {'fen': game['board'].fen()}, to=room)
            if game['board'].is_game_over():
                game['status'] = 'finished'
                socketio.emit('game_over', {'result': game['board'].result()}, to=room)

# --- ROUTES FLASK ---
@app.route('/')
def index():
    if 'username' not in session:
        return redirect(url_for('login'))
    return render_template('index.html', local_ip=get_best_ip(), username=session['username'])

@app.route('/login', methods=['GET', 'POST'])
def login():
    if request.method == 'POST':
        username = request.form.get('username', '').strip()
        if username:
            session['username'] = username
            conn = sqlite3.connect(DB_PATH)
            c = conn.cursor()
            c.execute("INSERT OR IGNORE INTO users (username) VALUES (?)", (username,))
            conn.commit()
            conn.close()
            return redirect(url_for('index'))
    return render_template('login.html')

@app.route('/logout')
def logout():
    session.pop('username', None)
    return redirect(url_for('login'))

# --- ÉVÉNEMENTS SOCKETIO ---
@socketio.on('connect')
def on_connect():
    pass # Le joueur rejoindra via create_room ou join_room

@socketio.on('disconnect')
def on_disconnect():
    if request.sid in player_sessions:
        info = player_sessions[request.sid]
        room = info['room']
        color = info['color']
        if room in games:
            games[room]['players_online'][color] = False
            socketio.emit('player_status', {'color': color, 'online': False}, to=room)
        del player_sessions[request.sid]

@socketio.on('get_public_rooms')
def list_rooms():
    public_list = []
    for rid, g in games.items():
        if g['mode'] == 'hvh' and g['status'] == 'playing':
            public_list.append({
                'id': rid,
                'white': g['players']['w'],
                'black': g['players']['b'] or "LIBRE (Rejoindre)"
            })
    emit('rooms_list', public_list)

@socketio.on('create_room')
def on_create(data):
    room = data['room']
    mode = data['mode']
    username = session.get('username', 'Anonyme')
    
    base_sec = int(data.get('time', 10)) * 60
    inc_sec = int(data.get('inc', 5))
    
    games[room] = {
        'board': chess.Board(),
        'mode': mode,
        'level': int(data.get('level', 1)),
        'players': {'w': username, 'b': None},
        'players_online': {'w': True, 'b': True if mode == 'hva' else False},
        'disconnect_timers': {'w': None, 'b': None},
        'moves_count': 0,
        'start_time': time.time(),
        'ai_color': 'b' if mode == 'hva' else None,
        'jokers': 3 if mode == 'hva' else 0,
        'config': {'base': base_sec, 'inc': inc_sec},
        'clocks': {
            'w': float(base_sec), 
            'b': float(base_sec), 
            'active': None,
            'last_tick': time.time()
        },
        'status': 'playing'
    }
    
    join_room(room)
    player_sessions[request.sid] = {'room': room, 'color': 'w'}
    
    emit('init_game', { 
        'fen': games[room]['board'].fen(), 
        'side': 'w', 
        'jokers': games[room]['jokers'],
        'time': base_sec,
        'inc': inc_sec
    })
    socketio.emit('rooms_updated')

@socketio.on('join_room')
def on_join(data):
    room = data['room']
    username = session.get('username', 'Anonyme')
    if room in games and not games[room]['players']['b']:
        games[room]['players']['b'] = username
        games[room]['players_online']['b'] = True
        join_room(room)
        player_sessions[request.sid] = {'room': room, 'color': 'b'}
        
        emit('init_game', { 
            'fen': games[room]['board'].fen(), 
            'side': 'b', 
            'jokers': 0,
            'time': games[room]['config']['base'],
            'inc': games[room]['config']['inc']
        })
        socketio.emit('player_joined', {'username': username}, to=room)
        socketio.emit('rooms_updated')
    elif room in games and games[room]['players'][player_sessions.get(request.sid, {}).get('color')] == username:
        # Reconnexion
        pass

@socketio.on('move')
def handle_move(data):
    room = data['room']
    if room not in games or games[room]['status'] != 'playing': return
    game = games[room]
    board = game['board']
    
    try:
        move = chess.Move.from_uci(data['move'])
        if move in board.legal_moves:
            color = 'w' if board.turn == chess.WHITE else 'b'
            
            if game['clocks']['active']:
                game['clocks'][color] += game['config']['inc']
            
            board.push(move)
            game['moves_count'] += 1
            
            game['clocks']['active'] = 'b' if board.turn == chess.BLACK else 'w'
            game['clocks']['last_tick'] = time.time()
            
            socketio.emit('board_state', {'fen': board.fen(), 'moves_count': game['moves_count']}, to=room)
            if board.is_game_over():
                game['status'] = 'finished'
                game['clocks']['active'] = None
                socketio.emit('game_over', {'result': board.result()}, to=room)
            elif game['mode'] == 'hva':
                socketio.start_background_task(ai_turn_manager, room)
    except: pass

@socketio.on('abort_resign')
def handle_abort_resign(data):
    room = data['room']
    if room not in games or games[room]['status'] != 'playing': return
    game = games[room]
    color = player_sessions.get(request.sid, {}).get('color')
    if not color: return

    if game['moves_count'] < 2:
        # ABORT
        game['status'] = 'finished'
        socketio.emit('game_over', {'result': 'aborted', 'by': color}, to=room)
    else:
        # RESIGN
        game['status'] = 'finished'
        winner = 'b' if color == 'w' else 'w'
        socketio.emit('game_over', {'result': 'resign', 'winner': winner}, to=room)

@socketio.on('use_joker')
def handle_joker(data):
    room = data['room']
    if room in games and games[room]['jokers'] > 0 and games[room]['status'] == 'playing':
        board = games[room]['board']
        steps = 2 if games[room]['mode'] == 'hva' else 1
        for _ in range(steps):
            if len(board.move_stack) > 0: board.pop()
            if games[room]['moves_count'] > 0: games[room]['moves_count'] -= 1
        games[room]['jokers'] -= 1
        emit('joker_used', { 'fen': board.fen(), 'remaining': games[room]['jokers'], 'moves_count': games[room]['moves_count'] }, to=room)


if __name__ == '__main__':
    print(f"\n🚀 ARENA DÉPLOYÉE SUR : http://{get_best_ip()}:5000\n")
    socketio.run(app, host='0.0.0.0', port=5000, debug=True)
