var express = require('express');
var path = require('path');
var favicon = require('serve-favicon');
var logger = require('morgan');
var cookieParser = require('cookie-parser');
var bodyParser = require('body-parser');
const session=require('express-session');

// 应用级中间件绑定到 app 对象 使用 app.use() 和 app.METHOD()
var app = express();
//var pkg = require('./package');

// 没有挂载路径的中间件，应用的每个请求都会执行该中间件
// config session
app.use(session({
  secret:'secret',
  cookie:{maxAge:1000*60*30},
  resave:false,
  saveUninitialized:true
}));

app.use(function(req,res,next)
{
    res.locals.user=req.session.user;
    let err=req.session.error;
    delete req.session.error;
    res.locals.message='';
    if(err)
    {
        res.locals.message='<div class="fuzq_message">'+err+'</div>';
    }
    next();
});

// view engine setup
app.set('views', path.join(__dirname, 'views'));
app.engine('.html', require('ejs').__express);
app.set('view engine', 'html');


// uncomment after placing your favicon in /public
//app.use(favicon(path.join(__dirname, 'public', 'favicon.ico')));
app.use(logger('dev'));
//Node.js body parsing middleware. req.body
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: false }));
// 加载用于解析 cookie 的第三方中间件
app.use(cookieParser());
// Express 唯一内置的中间件。它基于 serve-static，负责在 Express 应用中提托管静态资源。
// set the static folder as the public
app.use(express.static(path.join(__dirname, 'public')));

// 定义应用级路由
app.use('/', require('./routes/index'));
app.use('/users', require('./routes/users'));

// catch 404 and forward to error handler
app.use(function(req, res, next) {
  var err = new Error('Not Found');
  err.status = 404;
  next(err);
});

//错误处理中间件和其他中间件定义类似，只是要使用 4 个参数
// error handler
app.use(function(err, req, res, next) {
  // set locals, only providing error in development
  res.locals.message = err.message;
  res.locals.error = req.app.get('env') === 'development' ? err : {};

  // render the error page
  res.status(err.status || 500);
  res.render('error');
});

// module.exports = app; //npm start
/* app.listen(config.port, function(){
   console.log(`${pkg.name} listening on port ${config.port}`);
});*/

  console.log(process.env.NODE_ENV);

app.listen(3000);//nodemon