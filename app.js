var express = require('express');
var app = express();
var body_parser = require('body-parser');
var session = require('express-session');
var axios = require('axios');
var nodemailer = require('nodemailer');
var promise = require('bluebird');
var pgp = require('pg-promise')({
  promiseLib: promise
});
var db = pgp({database: 'scorehoard', user:'postgres'});   // TODO update database info
var apikey = require("apikeygen").apikey;

// password
var pbkdf2 = require('pbkdf2');
var crypto = require('crypto');
var salt = crypto.randomBytes(20).toString('hex');
var password = 'some-password';
var key = pbkdf2.pbkdf2Sync(
  password, salt, 36000, 256, 'sha256'
);
var hash = key.toString('hex');

// email
var transporter = nodemailer.createTransport({
  host: process.env['SMTP_HOST'],
  port: 465,
  secure: true,
  auth:{
    user: process.env['SMTP_USER'],
    pass: process.env['SMTP_PASSWORD']
  }
});


app.set('view engine', 'hbs');

app.use(body_parser.urlencoded({extended: false}));
app.use('/axios', express.static('node_modules/axios/dist'));
app.use('/static', express.static('public'));
app.use(session({
  secret: process.env.SECRET_KEY || 'dev',
  resave: true,
  saveUninitialized: false,
  cookie: {maxAge: 6000000}
}));


//API Get requests - work in progress
app.get('/api/:name', function (request, response, next) {
  var dbname = request.params.name;
  var valid_names = ['scores'];
  var scores = new Object;
  if (valid_names.indexOf(dbname) >= 0) {
    db.any(`SELECT player_name, score FROM ${dbname} WHERE game_id = 1 ORDER BY score DESC`)
      .then(function(resultsArray){
        console.log(resultsArray)
        for (let i = 0; i < resultsArray.length; i++){
          scores[i+1] = {};
          scores[i+1].name = resultsArray[i].player_name;
          console.log('resultsArray[i] is ',resultsArray[i].player_name)
          scores[i+1].score = resultsArray[i].score;
        }
        console.log('scores is ', scores)
        response.json(
          scores
        );
      })
      .catch(next);
  }
});

//API for adding scores - modify to validate and maybe remove url redirect since part of api
app.get('/add/:key', function(request, response, next){
  let key = request.params.key;
  let query_game = 'SELECT id, name, api_key_valid FROM game WHERE api_key = $1';
  db.one(query_game, key)     // get game info from api key
  .then (function(game){
    if (game.api_key_valid){
      let name = game.name;
      let user = request.query.user;
      let score = request.query.score;
      let game_id = game.id;
      let query_scores = 'INSERT INTO $1 (DEFAULT, game_id, player_name, score VALUES ($2, $3, $4)';
      db.any(query_scores, [game, game_id, user, score]);
    }
    else if (game.api_key_valid == false) {
      console.warn('API key not valid')
      return 0
    }
  })
  response.redirect('/')
});

app.get('/admin', function(request, response, next){
  let account = request.session.user || null;
  console.log('account is ', account)
  if (account == null) {response.redirect('/login'); return}    // redirect to login if not logged in
  let context = {account: account};

  db.one("SELECT * FROM company WHERE login = $1;", account)
    .then (function(company){
      console.log('account id is ', company.id)
      context['company'] = company;
      request.session.company = company;
      db.any("SELECT * FROM game WHERE company_id = $1 ORDER BY name", company.id)
      .then (function(resultsArray){
        console.log(resultsArray)
        for (i = 0; i < resultsArray.length; i++){
          if (resultsArray[i].api_key.length == 50){
            resultsArray[i]['key_present'] = true;
          }
          else {
            resultsArray[i]['key_present'] = false;
          }
        }
        context['games'] = resultsArray;
        console.log('context is ', context)
        response.render('admin.hbs', context)
      })
      .catch (function(err){
        console.error(err);
      })
    })
})

app.post('/admin', function(request, response, next){
  let company = request.session.company;
  let account = request.session.user || null;
  if (company.verified){
    context[verified = true]
  }
  if (request.body.api_key_generate) {
    // console.log('body is ',request.body)
    let key = apikey(50);
    let id = request.session.company.id;
    let game_id = request.body.game_id;
    let query = "UPDATE game SET api_key = $1 WHERE id = $2"
    db.none(query, [key, game_id])
      .then(function(){
        let login = request.session.user
        console.log('LOGIN IS ' +login);
        let mailOptions = {
          from:'"ScoreHoard" <donotreply@scorehoard.com>',
          to: login,
          subject: 'Confirmation Email',
          text: 'Thank you',
          html: `<p>Thank you for registering a game with ScoreHoard. May we fulfill your ScoreHoarding needs! Please click <a href="http://scorehoard.com/verify/${key}">here</a> to verify your game with us!</p>`
        };
        transporter.sendMail(mailOptions, (error, info) => {
          if (error) {
            return console.error(error);
          }
          console.log('Message send: ', info.messageId, info.response);
        });
        response.redirect('/admin');
    })
  }
  else {
    let name = request.body.name;
    let key = 'Pending';
    let query1 = 'INSERT INTO game VALUES (DEFAULT, \'$1#\', $2, FALSE, $3)'
    let promise1 = db.any(query1, [name, key, company.id]) // adds game to game table
    let query2 = 'CREATE TABLE \$1:value\(id SERIAL NOT NULL PRIMARY KEY, game_id INTEGER, player_name VARCHAR, score INTEGER);'
    let promise2 = db.any(query2, name) // creates table from game name
    return Promise.all([promise1, promise2])
      .then(function(){
        if (account == null) {response.redirect('/login'); return}
        response.redirect('/admin')
      })
      .catch(function(err){
        console.error(err)
      })
  }
})

//Passwords
function create_hash (password) {
  var salt = crypto.randomBytes(20).toString('hex');
  var key = pbkdf2.pbkdf2Sync(
    password, salt, 36000, 256, 'sha256'
  );
  var hash = key.toString('hex');
  var stored_pass = `pbkdf2_sha256$36000$${salt}$${hash}`;
  return stored_pass;
}

function check_pass (stored_pass, password){
  // checking a password
  var pass_parts = stored_pass.split('$');
  var key = pbkdf2.pbkdf2Sync( // make new hash
    password,
    pass_parts[2],
    parseInt(pass_parts[1]),
    256, 'sha256'
  );

  var hash = key.toString('hex');
  if (hash === pass_parts[3]) {
    console.log('Passwords Matched!');
    return true
  }
  else {
    console.log('No match')
  }
  return false;
}

// HOME
app.get('/', function(request, response){
  context = {};
  response.render('home.hbs', context)
})

 // PAYMENT
app.get('/payment', function(request, response){
  context = {title: 'ScoreHoard Payment'};
  response.render('payment.hbs', context)
})

// // NEW API KEY LOGIC
// app.post('/', function(request, response, next){
//   var key = apikey(50);  // generates 50 char base64 encoded key
//   var account = request.session.user;
//   db.one("SELECT id FROM company WHERE name = $1;", account)
//     .then(function(){
//       api_key = key
//     })
//     .catch(function(err){
//       next('Sorry, an error occurred: \n' + err);
//     })
//   context = {key: key}
//   response.render('home.hbs', context)
// })

//login page
app.get('/login', function(request, response){
  context = {title: 'Login'}
  response.render('login.hbs', context)
});

//login mechanics
app.post('/login', function(request, response) {
  let login = request.body.login;
  let password = request.body.password;
  let query = "SELECT password FROM company WHERE login = $1"
  db.one(query, login)
    .then (function(stored_pass){
      // hash user input
      return check_pass(stored_pass.password, password)
    })
    .then (function(pass_success){
      if (pass_success) {
        request.session.user = login;
        response.redirect('/admin');
      }
      else if (!pass_success){
        context = {title: 'Login', fail: true}
        response.render('login.hbs', context)
      }
    })
})

app.get('/logout', function(request, response, next) {
  request.session.destroy(function(err){
    if(err){console.error('Something went wrong: '+ err);}
    response.redirect('/');
  });
})

//Creating an account - We'll have to add verification
app.get('/create_account', function(request, response) {
  context = {title: 'Create account', login: request.session.user, anon: !request.session.user};
  response.render('create_account.hbs', context)
});

app.post('/create_account', function(request, response, next){
  let login = request.body.login;
  let password = request.body.password;
  let name = request.body.name;
  let pub = request.body.public;
  let verify_key = apikey(40);
  if (pub == 'on') {
    pub = true;
  }
  let mailOptions = {
    from:'"ScoreHoard" <donotreply@scorehoard.com>',
    to: login,
    subject: 'Confirmation Email',
    text: 'Thank you',
    html: `<p>Thank you for registering an account with ScoreHoard. May we fulfill your ScoreHoarding needs! Please click <a href="http://scorehoard.com/verify/${verify_key}">here</a> to verify your account with us!</p>`
  };
  console.log('options set')
  let stored_pass = create_hash(password);
  // id, login, password, public (boolean), name
  let query = 'SELECT login FROM company WHERE login = $1';
  db.none(query, login)
  .then(function(){
    let query = 'INSERT INTO company VALUES (DEFAULT, $1, $2, $3, $4, DEFAULT, $5)'
    db.none(query, [login, stored_pass, pub, name, verify_key])
      .then(function(){
        console.log('company inserted')
        request.session.user = name
        transporter.sendMail(mailOptions, (error, info) => {
          if (error) {
            return console.error(error);
          }
          console.log('Message send: ', info.messageId, info.response);
        });
        response.redirect('/');
      })
      .catch(function(err){next(err)})
    })
  .catch(function(err){
    if(err.received > 0){
      context.fail = true;
      response.render('create_account.hbs', context);
    }
    else{
      console.log(err);
    }
  })
});

// VERIFY ACCOUNT
app.get('/verify/:key', function(request, response, next){
  let key = request.params.key;
  if (key.length == 40) {     // company verification
    let query1 = 'UPDATE company SET verified = TRUE WHERE verify_key = $1';
    db.none(query1, key)
    .then(function() {
      let query2 = 'SELECT login FROM company WHERE verify_key = $1';
      let key = request.params.key;
      db.one(query2, key)
      .then(function(login){
        context = {verified: true};
        let mailOptions = {
          from:'"ScoreHoard" <donotreply@scorehoard.com>',
          to: login.login,
          subject: 'Thank you for verifying your account',
          text: 'Thank you',
          html: `<p>Thank you, your account has been verified. May we fulfill your ScoreHoarding needs!</p>`
        };
        transporter.sendMail(mailOptions, (error, info) => {
          if (error) {
            return console.error(error);
          }
          console.log('Message send: ', info.messageId, info.response);
        });
        response.redirect('/')
      })
    })
  }
  else if (key.length == 50) {      // game verification
    let query1 = 'UPDATE game SET api_key_valid = TRUE WHERE api_key = $1';
    let key = request.params.key;
    db.none(query1, key)
    .then(function(){
      let query2 = 'SELECT login FROM company INNER JOIN game ON game.company_id = company.id WHERE game.api_key = $1';
      let key = request.params.key;
      db.one(query2, key)
      .then(function(login){
        let mailOptions = {
          from:'"ScoreHoard" <donotreply@scorehoard.com>',
          to: login.login,
          subject: 'Thank you for verifying your game',
          text: 'Thank you',
          html: `<p>Thank you, your game has been verified. May we fulfill your ScoreHoarding needs!</p>`
        };
        transporter.sendMail(mailOptions, (error, info) => {
          if (error) {
            return console.error(error);
          }
          console.log('Message send: ', info.messageId, info.response);
        });
        response.redirect('/')
      })
    })
  }
})

app.listen(8000, function(){
  console.log('Listening on port 8000')
});
