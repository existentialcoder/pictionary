const debug = require('debug')('pictionary.game.looper');
const picWordGenerator = require('pic-word-gen');

class Looper {
  constructor (room, roomEventBridge) {
    this.ROUND_DURATION = 60000;
    this.GAME_STATE_IDLE = 0;
    this.GAME_STATE_ROUND_IN_PROGRESS = 1;
    this.GAME_STATE_WAIT_FOR_NEXT_ROUND = 2;
    this.GAME_STATE_ANNOUNCE_WINNER = 3;
    this._wordsUsedInGame = [];
    this._currentRoundStartTime = 0;
    this._roundStarted = false;
    this._roundsLeft = 0;
    this._totalRounds = 0;
    this._room = room;
    this._users = [];
    this._gameState = this.GAME_STATE_IDLE;
    this._currentWord = null;
    this._winnerAnnouncementInProgress = false;
    this._currentUserDrawIndex = 0;
    this._roomEventBridge = roomEventBridge;
    this._roomEventBridge.broadcastRoomState('GE_IDLE');
    this._roomEventBridge.on('GE_NEW_GUESS', (userId, guess) => {
      this.evaluateGuess(userId, guess);
    });
    this._roomEventBridge.on('C_S_LEAVE_ROOM', (userId) => {
      this.removeUser(userId);
    });
    this.foundUsersCount = 0;
    this.evalRoundHandle = null;
  }

  addUser (dbUser, socketId) {
    const foundUser = this._users.find((user) => dbUser.id === user.id);
    if (!foundUser) {
      this._users.push({ id: dbUser.id, name: dbUser.name, score: 0, roundInfo: { foundWord: false, isDrawing: false } });
    } else {
      console.log('user already in room');
    }
    this._roomEventBridge.updateUserSocket(dbUser.id, socketId);
    this._roomEventBridge.broadcastScores(this._users);
    switch (this._gameState) {
      case this.GAME_STATE_IDLE:
        this._roomEventBridge.sendRoomStateToPlayer(dbUser.id, 'GE_IDLE');
        break;
      case this.GAME_STATE_WAIT_FOR_NEXT_ROUND:
        this._roomEventBridge.sendRoomStateToPlayer(dbUser.id, 'GE_WAIT_FOR_NEXT_ROUND', {
          previousWord: this._currentWord,
          round: this._roundsLeft,
          total: this._totalRounds
        });
        break;
      case this.GAME_STATE_ROUND_IN_PROGRESS: {
        const currentDrawingUser = this._users[this._currentUserDrawIndex];
        this._roomEventBridge.sendRoomStateToPlayer(dbUser.id, 'GE_NEW_ROUND', {
          round: this._roundsLeft,
          total: this._totalRounds,
          currentDrawingUser,
          startTimestamp: this._currentRoundStartTime
        });
        break;
      }
      case this.GAME_STATE_ANNOUNCE_WINNER:
        this._roomEventBridge.broadcastRoomState('GE_ANNOUNCE_WINNER', {
          previousWord: this._currentWord,
          winners: this.winners()
        });
        break;
      default:
        this._roomEventBridge.broadcastRoomState('GE_IDLE');
        break;
    }
    debug('Added new user - ', dbUser);
  }

  removeUser (userId) {
    // remove from _users
    const indexOfUser = this._users.map((user) => user.id).indexOf(userId);
    if (indexOfUser >= 0) {
      this._users.splice(indexOfUser, 1);
      this._roomEventBridge.broadcastScores(this._users);
    }
  }

  hasEveryoneFoundTheWord () {
    return (this.foundUsersCount >= (this._users.length - 1));
  }

  clearRoundInfoForAllUsers () {
    this._users.forEach(user => {
      user.roundInfo.foundWord = false;
      user.roundInfo.isDrawing = false;
    });
  }

  evaluateGuess (userId, guess) {
    if (!guess) return;
    if (guess.trim().toLowerCase() === this._currentWord.trim().toLowerCase()) {
      debug('Correct guess by user - ', userId);
      const foundUser = this._users.find((user) => userId === user.id);
      if (foundUser) {
        foundUser.score += Math.max(5, 10 - this.foundUsersCount); // The first to score gets 10 points and it goes down till 5 points
        foundUser.roundInfo.foundWord = true;
        this.foundUsersCount = this.foundUsersCount + 1;
        const currentDrawingUser = this._users[this._currentUserDrawIndex];
        if (currentDrawingUser) {
          currentDrawingUser.score += 3;
          this._roomEventBridge.broadcastScores(this._users);
          // TODO: fetch username and passit across. Why should frontend deal with UserId of other users
          this._roomEventBridge.broadcastLastGuess(
            userId.split('_')[0],
            guess,
            true
          );

          // If everyone found the word, just stop the round and go on to the next round
          if (this.hasEveryoneFoundTheWord()) {
            const that = this;
            setTimeout(() => {
              clearTimeout(that.evalRoundHandle);
              that.evaluateRound();
            }, 2000);
          }
        }
      }
    } else {
      // TODO: fetch username and passit across. Why should frontend deal with UserId of other users
      this._roomEventBridge.broadcastLastGuess(
        userId.split('_')[0],
        guess,
        false
      );
    }
  }

  evaluateRound () {
    // At the end of round, do _rounds--
    // Repeat till _rounds == 0
    this._roundsLeft--;
    if (this._roundsLeft <= 0) {
      // Game over
      // emit game over
      this.stopGame();
      // announce winners
    } else {
      this._gameState = this.GAME_STATE_WAIT_FOR_NEXT_ROUND;
      this._roomEventBridge.broadcastRoomState(
        'GE_WAIT_FOR_NEXT_ROUND',
        {
          previousWord: this._currentWord,
          round: this._roundsLeft,
          total: this._totalRounds
        }
      );
      const that = this;
      setTimeout(() => {
        debug('Users count', that._users.length);
        if (that._users.length > 1) {
          that.startRound();
        } else {
          // Users have left before the next round starts.
          // Stop the game and Announce winner
          that.stopGame();
        }
      }, 5000);
    }
  }

  getDifficultyLevel (roundsLeft, totalRounds) {
    const roundsLeftPercentage = (1 - (roundsLeft / totalRounds)) * 100;
    let difficultyLevel = 'easy';
    if (roundsLeftPercentage > 66) {
      difficultyLevel = 'hard';
    } else if (roundsLeftPercentage > 33) {
      difficultyLevel = 'medium';
    } else {
      difficultyLevel = 'easy';
    }
    debug(`Round ${totalRounds - roundsLeft + 1} : Difficulty Level ${difficultyLevel}`);
    return difficultyLevel;
  }

  startRound () {
    debug('start new round');
    if (this.evalRoundHandle) {
      clearTimeout(this.evalRoundHandle);
    }

    // clear roundInfo.foundWord and roundInfo.isDrawing
    this.clearRoundInfoForAllUsers();

    this._gameState = this.GAME_STATE_ROUND_IN_PROGRESS;
    this._roundStarted = true;
    this._currentRoundStartTime = +new Date(); // record the timestamp during at which the round started.
    this.foundUsersCount = 0;

    // Assign a user to draw
    this._currentUserDrawIndex =
      (this._totalRounds - this._roundsLeft) % this._users.length;
    const currentDrawingUser = this._users[this._currentUserDrawIndex];
    currentDrawingUser.roundInfo.isDrawing = true;
    this._roomEventBridge.broadcastScores(this._users);

    debug('Current User Drawing - ', currentDrawingUser);
    // Sometimes the currentDrawing user quits while its his turn to draw. SKIP the round!
    if (!currentDrawingUser) {
      clearTimeout(this.evalRoundHandle);
      this.evaluateRound();
      return;
    }

    const difficultyLevel = this.getDifficultyLevel(this._roundsLeft, this._totalRounds);
    // Pick a word using pic-word-gen library
    // Repeat this till the words are not repeated
    do {
      this._currentWord = picWordGenerator.generateWord(difficultyLevel);
    } while (this._wordsUsedInGame.includes(this._currentWord));
    this._wordsUsedInGame.push(this._currentWord);

    // emit round started
    this._roomEventBridge.broadcastRoomState('GE_NEW_ROUND', {
      round: this._roundsLeft,
      total: this._totalRounds,
      currentDrawingUser,
      startTimestamp: this._currentRoundStartTime
    });
    this._roomEventBridge.sendWordToPlayer(
      currentDrawingUser.id,
      this._currentWord
    );

    // Assign other users to guess

    // start Timer
    const that = this;
    this.evalRoundHandle = setTimeout(() => that.evaluateRound(), this.ROUND_DURATION);
  }

  _resetScores () {
    this._users.forEach((user) => {
      user.score = 0;
    });
    this.foundUsersCount = 0;
  }

  stopGame () {
    this._gameState = this.GAME_STATE_ANNOUNCE_WINNER;
    debug('Game over, Announce winner');
  }

  winners () {
    let winners = [];
    let highScore = 0;

    this._users.forEach(user => {
      if (user.score >= highScore) {
        if (user.score > highScore) {
          highScore = user.score;
          winners = [];
        }
        winners.push(user);
      }
    });
    debug('Winner Announcement - ', winners);
    if (highScore > 0) {
      return winners;
    } else {
      return null;
    }
  }

  announceWinner () {
    debug('Winner announced!');
    this._roomEventBridge.broadcastRoomState('GE_ANNOUNCE_WINNER', {
      previousWord: this._currentWord,
      winners: this.winners()
    });
    this._roundsLeft = 0;
    this._totalRounds = 0;
    this._currentWord = null;
    this._wordsUsedInGame = [];
    this._currentUserDrawIndex = 0;
    this._winnerAnnouncementInProgress = true;
    const that = this;
    setTimeout(() => {
      that._gameState = that.GAME_STATE_IDLE;
      that._winnerAnnouncementInProgress = false;
    }, 10 * 1000);
  }

  loop () {
    debug('GAME_STATE: ', this._gameState);
    switch (this._gameState) {
      case this.GAME_STATE_IDLE:
        if (this._users.length > 1) {
          this._gameState = this.GAME_STATE_ROUND_IN_PROGRESS;
          this._resetScores();
          this._roomEventBridge.broadcastRoomState(
            'GE_NEW_GAME',
            this.ROUND_DURATION
          );
          this._roomEventBridge.broadcastScores(this._users);
          switch (this._users.length) {
            case 2:
              this._totalRounds = 8;
              break;
            case 3:
              this._totalRounds = 9;
              break;
            case 4:
              this._totalRounds = 8;
              break;
            case 5:
              this._totalRounds = 10;
              break;
            case 6:
              this._totalRounds = 12;
              break;
            case 7:
              this._totalRounds = 14;
              break;
            default:
              this._totalRounds = this._users.length;
              break;
          }
          this._roundsLeft = this._totalRounds;

          this.startRound();
        }
        break;
      case this.GAME_STATE_ROUND_IN_PROGRESS:
        if (this._users.length < 2) {
          this.stopGame();
        }
        break;
      case this.GAME_STATE_ANNOUNCE_WINNER:
        if (!this._winnerAnnouncementInProgress) this.announceWinner();
        break;
      default:
        break;
    }
  }
}

module.exports = Looper;
