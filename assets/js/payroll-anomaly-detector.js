(function(){
  'use strict';

  function pctChange(current, previous){
    current=Number(current||0); previous=Number(previous||0);
    if(previous===0) return current===0?0:100;
    return ((current-previous)/Math.abs(previous))*100;
  }

  function detect(currentRows, previousRows, options){
    options=Object.assign({ salaryPct:20, overtimeHours:50, duplicateBank:true }, options||{});
    var prevByStaff=new Map((previousRows||[]).map(function(r){ return [r.staff_id||r.employee_id, r]; }));
    var bankOwners=new Map();
    var issues=[];

    (currentRows||[]).forEach(function(r){
      var id=r.staff_id||r.employee_id||r.id;
      var name=r.full_name||r.employee_name||'Employee';
      var prev=prevByStaff.get(id);
      var currentGross=Number(r.gross_pay||r.gross||r.basic_salary||0);
      var prevGross=prev?Number(prev.gross_pay||prev.gross||prev.basic_salary||0):0;

      if(prev && prevGross>0){
        var change=pctChange(currentGross,prevGross);
        if(Math.abs(change)>=options.salaryPct){
          issues.push({severity:'high',type:'pay_change',staff_id:id,label:name+' pay changed '+Math.round(change)+'%',detail:'Previous '+prevGross.toFixed(2)+', current '+currentGross.toFixed(2)});
        }
      }

      var overtime=Number(r.overtime_hours||0);
      if(overtime>=options.overtimeHours){
        issues.push({severity:'medium',type:'overtime',staff_id:id,label:name+' has '+overtime+' overtime hours'});
      }

      if(!r.bank_account_number){
        issues.push({severity:'high',type:'missing_bank',staff_id:id,label:name+' has no bank account details'});
      }

      if(!r.tax_number){
        issues.push({severity:'medium',type:'missing_tax',staff_id:id,label:name+' has no tax number'});
      }

      var bank=String(r.bank_account_number||'').replace(/\s/g,'');
      if(options.duplicateBank && bank){
        if(bankOwners.has(bank) && bankOwners.get(bank)!==id){
          issues.push({severity:'high',type:'duplicate_bank',staff_id:id,label:'Duplicate bank account detected',detail:name+' shares an account with another employee'});
        } else bankOwners.set(bank,id);
      }

      if(Number(r.net_pay||0)<0){
        issues.push({severity:'high',type:'negative_net',staff_id:id,label:name+' has negative net pay'});
      }

      if(Number(r.paye||0)===0 && currentGross>0){
        issues.push({severity:'low',type:'zero_paye',staff_id:id,label:name+' has zero PAYE',detail:'Review if this is expected for the employee\'s taxable income.'});
      }
    });

    return issues;
  }

  function summary(issues){
    issues=issues||[];
    return {
      total:issues.length,
      high:issues.filter(function(i){return i.severity==='high';}).length,
      medium:issues.filter(function(i){return i.severity==='medium';}).length,
      low:issues.filter(function(i){return i.severity==='low';}).length
    };
  }

  window.BursePayrollAnomalies={detect:detect,summary:summary,pctChange:pctChange};
})();