import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { api } from '../api';
import { ValidationPolicySettings } from './ValidationPolicySettings';
import { DirectionMarkerAction } from './DirectionMarkerAction';
let container:HTMLDivElement,root:Root;
beforeEach(()=>{container=document.createElement('div');document.body.append(container);root=createRoot(container);});
afterEach(()=>{act(()=>root.unmount());container.remove();vi.restoreAllMocks();});
const textarea=(value:string)=>{const field=container.querySelector('textarea')!;Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value')!.set!.call(field,value);field.dispatchEvent(new Event('input',{bubbles:true}));};
it('lets a contributor enable strict with a reason and reports released claims',async()=>{
 vi.spyOn(api,'validationPolicy').mockResolvedValue({mode:'legacy',generation:0});
 const change=vi.spyOn(api,'setValidationPolicy').mockResolvedValue({mode:'strict',releasedTaskIds:['task_1']});
 await act(async()=>root.render(<ValidationPolicySettings projectId="p1" canContribute/>));
 act(()=>textarea('Require evidence before this project starts work.'));
 await act(async()=>container.querySelector('form')!.dispatchEvent(new Event('submit',{bubbles:true,cancelable:true})));
 expect(change).toHaveBeenCalledWith('p1','strict','Require evidence before this project starts work.');
 expect(container.textContent).toContain('Released 1 claims: task_1');expect(container.textContent).toContain('actor-reported');
});
it('does not offer policy mutation to a viewer',async()=>{
 vi.spyOn(api,'validationPolicy').mockResolvedValue({mode:'strict',generation:1});
 await act(async()=>root.render(<ValidationPolicySettings projectId="p1" canContribute={false}/>));
 expect(container.querySelector('form')).toBeNull();expect(container.textContent).toContain('Current policy: strict');
});
it('marks an existing comment with explicit intent and explains revoked ownership',async()=>{
 const mark=vi.spyOn(api,'markChangedDirection').mockResolvedValue({});
 act(()=>root.render(<DirectionMarkerAction projectId="p1" taskId="t1" sourceType="comment" sourceId="c1"/>));
 act(()=>container.querySelector('button')!.click());act(()=>textarea('Use the revised repository target from this decision.'));
 await act(async()=>container.querySelector('form')!.dispatchEvent(new Event('submit',{bubbles:true,cancelable:true})));
 expect(mark).toHaveBeenCalledWith('p1',{taskId:'t1',sourceType:'comment',sourceId:'c1',reason:'Use the revised repository target from this decision.'});
 expect(container.textContent).toContain('Stop implementation');
});
