import os

from flask import Flask
from flask_compress import Compress
from flask_socketio import SocketIO

app = Flask(__name__)
Compress(app)

app.config['SECRET_KEY'] = os.getenv('SECRET_KEY', os.urandom(24).hex())
app.config['TEMPLATES_AUTO_RELOAD'] = True

socketio = SocketIO(app)

from . import routes, websocket  # noqa: E402,F401
